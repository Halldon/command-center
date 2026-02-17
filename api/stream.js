const { readPublishedState, clampNumber, nowIso } = require('./_central_state');
const { proxyToControlPlane } = require('./_control_plane_proxy');

const DEFAULT_WAIT_MS = 25000;
const DEFAULT_POLL_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamConfig() {
  const waitMs = clampNumber(
    process.env.COMMAND_CENTER_STREAM_WAIT_MS,
    DEFAULT_WAIT_MS,
    1000,
    30000
  );
  const pollMs = clampNumber(
    process.env.COMMAND_CENTER_STREAM_POLL_MS,
    DEFAULT_POLL_MS,
    200,
    5000
  );
  return { waitMs, pollMs };
}

function buildStreamMeta(state, reason) {
  const staleProjects = Array.isArray(state?.realtime?.staleProjects)
    ? state.realtime.staleProjects
    : [];
  const generatedAtMs = Date.parse(String(state?.generatedAt || ''));
  const snapshotStalenessSec = Number.isFinite(generatedAtMs)
    ? Math.max(0, Math.floor((Date.now() - generatedAtMs) / 1000))
    : null;
  return {
    enabled: true,
    command: 'central-ingest',
    intervalMs: null,
    watchPaths: [],
    inFlight: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastOkAt: nowIso(),
    lastDurationMs: null,
    lastError: null,
    lastReason: reason || 'state',
    runCount: null,
    snapshotStalenessSec,
    projectContractCount: Number(state?.projectContracts?.projectCount || staleProjects.length),
    projectContractStaleCount: staleProjects.length,
    staleProjectIds: staleProjects.map((row) => String(row?.projectId || '')).filter(Boolean).slice(0, 10)
  };
}

async function waitForUpdate(sinceId, config) {
  const deadline = Date.now() + config.waitMs;
  let current = readPublishedState();
  if (!sinceId || String(current.version) !== sinceId) {
    return { changed: true, ...current, reason: 'changed' };
  }

  while (Date.now() < deadline) {
    await sleep(config.pollMs);
    current = readPublishedState();
    if (!sinceId || String(current.version) !== sinceId) {
      return { changed: true, ...current, reason: 'changed' };
    }
  }

  return { changed: false, ...current, reason: 'heartbeat' };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
  res.setHeader('Cache-Control', 'no-cache, no-transform');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (await proxyToControlPlane(req, res, '/api/stream')) return;

    const cfg = streamConfig();
    const sinceId = String(req.headers['last-event-id'] || req.query?.since || '').trim();
    const result = await waitForUpdate(sinceId, cfg);
    const sync = buildStreamMeta(result.state, result.reason);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write('retry: 1000\n');
    if (result.changed) {
      res.write(`id: ${result.version}\n`);
      res.write('event: snapshot\n');
      res.write(`data: ${JSON.stringify({
        snapshot: result.state,
        generatedAt: result.state?.generatedAt || null,
        mtimeMs: result.mtimeMs,
        version: String(result.version),
        sync
      })}\n\n`);
    } else {
      res.write('event: heartbeat\n');
      res.write(`data: ${JSON.stringify({
        ok: true,
        version: String(result.version),
        generatedAt: result.state?.generatedAt || null,
        mtimeMs: result.mtimeMs,
        sync
      })}\n\n`);
    }
    res.end();
  } catch (err) {
    res.status(500).json({ error: 'stream endpoint failed', details: String(err.message || err) });
  }
};
