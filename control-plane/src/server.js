require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { readConfig } = require('./config');
const { query } = require('./db');
const {
  ingestCloudEventsDb,
  loadPublishedState,
  evaluateFreshnessSweep,
  resolveIngestAuthToken,
  projectScopeAllowed,
  nowIso
} = require('./service');

const config = readConfig();
const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '4mb' }));

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body;
}

function tokenFromReq(req) {
  const xToken = req.headers['x-command-center-ingest-key'];
  if (xToken) return String(xToken).trim();
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1', [], config.databaseUrl);
    return res.status(200).json({
      ok: true,
      service: 'command-center-control-plane',
      ts: nowIso()
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
});

app.get('/api/ingest', (_req, res) => {
  return res.status(200).json({
    endpoint: '/api/ingest',
    protocol: 'CloudEvents + OpenTelemetry attributes',
    auth: {
      mode: 'project-scoped ingest keys or env ingest token',
      header: 'X-Command-Center-Ingest-Key or Authorization: Bearer <token>'
    },
    acceptedForms: [
      'single CloudEvent object',
      '{ "events": [CloudEvent, ...], "idempotencyKey": "optional-batch-key" }'
    ]
  });
});

app.post('/api/ingest', async (req, res) => {
  try {
    const payload = parseBody(req);
    const events = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.events)
        ? payload.events
        : [payload];
    const scopedProjectIds = new Set();
    for (const raw of events) {
      const event = raw?.event && typeof raw.event === 'object' ? raw.event : raw;
      const fromExt = event?.projectid || event?.project_id;
      const fromData = event?.data?.projectId || event?.data?.project_id;
      const fromSubject = event?.subject;
      [fromExt, fromData, fromSubject].forEach((candidate) => {
        const key = String(candidate || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        if (key) scopedProjectIds.add(key);
      });
    }

    const auth = await resolveIngestAuthToken(tokenFromReq(req), config);
    if (!auth.ok) {
      return res.status(401).json({
        error: 'Unauthorized ingest token.',
        reason: auth.reason
      });
    }
    if (auth.key?.project_id) {
      const scoped = [...scopedProjectIds];
      if (scoped.length && scoped.some((projectId) => !projectScopeAllowed(auth.key, projectId))) {
        return res.status(403).json({
          error: 'Token scope mismatch for one or more project events.',
          tokenProjectId: auth.key.project_id
        });
      }
    }

    const result = await ingestCloudEventsDb(payload, req.headers || {}, config);
    const status = result.rejected?.length ? 207 : 200;
    return res.status(status).json(result);
  } catch (err) {
    return res.status(500).json({
      error: 'ingest failed',
      details: String(err.message || err)
    });
  }
});

app.get('/api/state', async (_req, res) => {
  try {
    await evaluateFreshnessSweep(config);
    const published = await loadPublishedState(config);
    const staleProjects = published.state?.realtime?.staleProjects || [];
    if (config.blockStaleApi && staleProjects.length > 0) {
      return res.status(503).json({
        error: 'Publish blocked: stale project heartbeats present.',
        staleProjects
      });
    }
    return res.status(200).json({
      ...published.state,
      _meta: {
        source: 'control-plane-postgres',
        version: String(published.version),
        staleProjects,
        staleCount: staleProjects.length
      }
    });
  } catch (err) {
    return res.status(500).json({
      error: 'state failed',
      details: String(err.message || err)
    });
  }
});

async function waitForStateChange(since, waitMs, pollMs) {
  const deadline = Date.now() + waitMs;
  let current = await loadPublishedState(config);
  if (!since || String(current.version) !== since) {
    return { changed: true, ...current };
  }
  while (Date.now() < deadline) {
    await sleep(pollMs);
    await evaluateFreshnessSweep(config);
    current = await loadPublishedState(config);
    if (!since || String(current.version) !== since) {
      return { changed: true, ...current };
    }
  }
  return { changed: false, ...current };
}

app.get('/api/stream', async (req, res) => {
  try {
    const since = String(req.headers['last-event-id'] || req.query?.since || '').trim();
    const result = await waitForStateChange(since, config.sseWaitMs, config.ssePollMs);
    const staleProjects = result.state?.realtime?.staleProjects || [];
    const generatedAtMs = Date.parse(String(result.state?.generatedAt || ''));
    const sync = {
      enabled: true,
      command: 'control-plane-postgres',
      intervalMs: null,
      watchPaths: [],
      inFlight: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastOkAt: nowIso(),
      lastDurationMs: null,
      lastError: null,
      lastReason: result.changed ? 'changed' : 'heartbeat',
      runCount: null,
      snapshotStalenessSec: Number.isFinite(generatedAtMs) ? Math.max(0, Math.floor((Date.now() - generatedAtMs) / 1000)) : null,
      projectContractCount: Number(result.state?.projectContracts?.projectCount || staleProjects.length),
      projectContractStaleCount: staleProjects.length,
      staleProjectIds: staleProjects.map((row) => String(row?.projectId || '')).filter(Boolean).slice(0, 20)
    };

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write('retry: 1000\n');
    if (result.changed) {
      res.write(`id: ${result.version}\n`);
      res.write('event: snapshot\n');
      res.write(`data: ${JSON.stringify({
        snapshot: result.state,
        generatedAt: result.state?.generatedAt || null,
        version: String(result.version),
        sync
      })}\n\n`);
    } else {
      res.write('event: heartbeat\n');
      res.write(`data: ${JSON.stringify({
        ok: true,
        generatedAt: result.state?.generatedAt || null,
        version: String(result.version),
        sync
      })}\n\n`);
    }
    res.end();
  } catch (err) {
    res.status(500).json({
      error: 'stream failed',
      details: String(err.message || err)
    });
  }
});

app.get('/api/adapters', async (req, res) => {
  try {
    if (!config.adminToken || String(req.headers['x-command-center-admin-token'] || '').trim() !== config.adminToken) {
      return res.status(401).json({ error: 'Unauthorized admin token' });
    }
    const { rows } = await query(
      `
      SELECT
        project_id, name, type, owner, priority, aliases,
        heartbeat_interval_seconds, max_event_age_seconds, required_metrics,
        severity_map, runbook_links, event_types, active, updated_at
      FROM project_adapters
      ORDER BY project_id
      `,
      [],
      config.databaseUrl
    );
    return res.status(200).json({ adapters: rows });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.use((err, _req, res, _next) => {
  res.status(500).json({
    error: 'Unhandled control-plane error',
    details: String(err.message || err)
  });
});

const server = app.listen(config.port, () => {
  console.log(`[control-plane] listening on :${config.port}`);
});

const sweepTimer = setInterval(() => {
  evaluateFreshnessSweep(config).catch((err) => {
    console.error('[control-plane] freshness sweep failed', err);
  });
}, config.heartbeatEvaluationIntervalMs);
sweepTimer.unref();

async function shutdown(code = 0) {
  try {
    clearInterval(sweepTimer);
    server.close(() => process.exit(code));
  } catch (_) {
    process.exit(code);
  }
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
