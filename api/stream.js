const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SNAPSHOT_PATH = path.join(process.cwd(), 'snapshot.json');
const OPERATOR_CONFIG_PATH = path.join(process.cwd(), 'operator.config.json');
const DEFAULT_SYNC_CMD = 'bash scripts_sync_snapshot.sh';
const DEFAULT_WAIT_MS = 25000;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_SYNC_INTERVAL_MS = 5000;
const DEFAULT_SYNC_TIMEOUT_MS = 120000;
const DEFAULT_SYNC_FAILURE_BACKOFF_MS = 30000;

const liveSyncState = {
  inFlight: null,
  lastStartedAt: 0,
  lastFinishedAt: 0,
  lastOkAt: 0,
  lastError: '',
  lastDurationMs: 0,
  lastReason: '',
  runCount: 0,
  nextAllowedAt: 0
};

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !/^(0|false|off|no)$/i.test(String(raw || '').trim());
}

function isoOrNull(ms) {
  if (!ms || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSnapshotWithMeta() {
  const stat = fs.statSync(SNAPSHOT_PATH);
  const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  return {
    snapshot: JSON.parse(raw),
    mtimeMs: stat.mtimeMs
  };
}

function readOperatorConfig() {
  try {
    const raw = fs.readFileSync(OPERATOR_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function projectMetricWatchPaths(project) {
  const repoPath = String(project?.repoPath || '').trim();
  const metricsSource = String(project?.metricsSource || '');
  const out = [];
  if (!repoPath || !metricsSource) return out;

  const match = metricsSource.match(/\(([^)]+)\)/);
  const body = match ? match[1] : metricsSource;
  const tokens = body
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const cleaned = token.replace(/^["'`]|["'`]$/g, '');
    if (!cleaned || !cleaned.includes('/')) continue;
    const candidate = path.isAbsolute(cleaned)
      ? cleaned
      : path.join(repoPath, cleaned);
    out.push(candidate);
  }

  return out;
}

function buildWatchPaths(config) {
  const liveSync = config?.liveSync && typeof config.liveSync === 'object' ? config.liveSync : {};
  const configuredWatch = Array.isArray(liveSync.watchPaths) ? liveSync.watchPaths : [];
  const fromProjects = (Array.isArray(config?.projects) ? config.projects : [])
    .flatMap(projectMetricWatchPaths);
  const paths = [...configuredWatch, ...fromProjects]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const deduped = [];
  for (const candidate of paths) {
    if (!deduped.includes(candidate)) deduped.push(candidate);
  }
  return deduped;
}

function wildcardRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`);
}

function latestMtimeForPath(candidate) {
  const value = String(candidate || '').trim();
  if (!value) return 0;

  if (value.includes('*')) {
    const dir = path.dirname(value);
    const base = path.basename(value);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return 0;
    }
    const re = wildcardRegex(base);
    let latest = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!re.test(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > latest) latest = stat.mtimeMs;
      } catch (_) {
        // Ignore one bad file and keep scanning.
      }
    }
    return latest;
  }

  if (/\/\.[a-z0-9]+$/i.test(value)) {
    const dir = path.dirname(value);
    const ext = path.basename(value);
    return latestMtimeForPath(path.join(dir, `*${ext}`));
  }

  try {
    const stat = fs.statSync(value);
    return stat.mtimeMs;
  } catch (_) {
    return 0;
  }
}

function latestWatchMtime(paths) {
  let latest = 0;
  for (const candidate of paths) {
    const mtime = latestMtimeForPath(candidate);
    if (mtime > latest) latest = mtime;
  }
  return latest;
}

function liveSyncConfig() {
  const operatorConfig = readOperatorConfig();
  const liveSync = operatorConfig?.liveSync && typeof operatorConfig.liveSync === 'object'
    ? operatorConfig.liveSync
    : {};
  const enabled = envBool('COMMAND_CENTER_AUTO_SYNC', liveSync.enabled !== false);
  const forceRunWithoutWatchPaths = envBool(
    'COMMAND_CENTER_FORCE_SYNC_WITHOUT_WATCH_PATHS',
    liveSync.forceRunWithoutWatchPaths === true
  );
  const command = String(process.env.COMMAND_CENTER_LIVE_SYNC_CMD || liveSync.cmd || DEFAULT_SYNC_CMD).trim();
  const syncIntervalMs = clampNumber(
    process.env.COMMAND_CENTER_SYNC_INTERVAL_MS || liveSync.intervalMs,
    DEFAULT_SYNC_INTERVAL_MS,
    1000,
    600000
  );
  const waitMs = clampNumber(
    process.env.COMMAND_CENTER_STREAM_WAIT_MS || liveSync.streamWaitMs,
    DEFAULT_WAIT_MS,
    1000,
    30000
  );
  const pollMs = clampNumber(
    process.env.COMMAND_CENTER_STREAM_POLL_MS || liveSync.streamPollMs,
    DEFAULT_POLL_MS,
    250,
    5000
  );
  const syncTimeoutMs = clampNumber(
    process.env.COMMAND_CENTER_SYNC_TIMEOUT_MS || liveSync.syncTimeoutMs,
    DEFAULT_SYNC_TIMEOUT_MS,
    1000,
    300000
  );
  const syncFailureBackoffMs = clampNumber(
    process.env.COMMAND_CENTER_SYNC_FAILURE_BACKOFF_MS || liveSync.syncFailureBackoffMs,
    DEFAULT_SYNC_FAILURE_BACKOFF_MS,
    1000,
    600000
  );
  const watchPaths = buildWatchPaths(operatorConfig);
  return {
    enabled,
    forceRunWithoutWatchPaths,
    command,
    syncIntervalMs,
    waitMs,
    pollMs,
    syncTimeoutMs,
    syncFailureBackoffMs,
    watchPaths
  };
}

function liveSyncMeta(config, snapshot) {
  const generatedAtMs = Date.parse(String(snapshot?.generatedAt || ''));
  const referenceMs = Number.isFinite(generatedAtMs) ? generatedAtMs : 0;
  const snapshotStalenessSec = referenceMs
    ? Math.max(0, Math.floor((Date.now() - referenceMs) / 1000))
    : null;
  return {
    enabled: Boolean(config.enabled),
    command: config.command || null,
    intervalMs: config.syncIntervalMs,
    watchPaths: config.watchPaths,
    inFlight: Boolean(liveSyncState.inFlight),
    lastStartedAt: isoOrNull(liveSyncState.lastStartedAt),
    lastFinishedAt: isoOrNull(liveSyncState.lastFinishedAt),
    lastOkAt: isoOrNull(liveSyncState.lastOkAt),
    lastDurationMs: liveSyncState.lastDurationMs || null,
    lastError: liveSyncState.lastError || null,
    lastReason: liveSyncState.lastReason || null,
    runCount: liveSyncState.runCount,
    snapshotStalenessSec
  };
}

async function maybeRunLiveSync(config, snapshotMtimeMs) {
  if (!config.enabled) {
    liveSyncState.lastReason = 'disabled';
    return { ok: true, ran: false, reason: 'disabled' };
  }
  if (!config.command) {
    liveSyncState.lastReason = 'missing_command';
    return { ok: false, ran: false, reason: 'missing_command' };
  }
  if (liveSyncState.inFlight) return liveSyncState.inFlight;

  const now = Date.now();
  if (now < liveSyncState.nextAllowedAt) {
    liveSyncState.lastReason = 'cooldown';
    return { ok: true, ran: false, reason: 'cooldown' };
  }

  const upstreamMtimeMs = latestWatchMtime(config.watchPaths);
  if (upstreamMtimeMs <= 0 && !config.forceRunWithoutWatchPaths) {
    liveSyncState.lastReason = 'no_watch_paths';
    liveSyncState.nextAllowedAt = now + config.syncIntervalMs;
    return { ok: true, ran: false, reason: 'no_watch_paths' };
  }
  const looksUpToDate = upstreamMtimeMs > 0 && snapshotMtimeMs > 0 && upstreamMtimeMs <= snapshotMtimeMs;
  if (looksUpToDate && liveSyncState.lastOkAt > 0) {
    liveSyncState.lastReason = 'up_to_date';
    liveSyncState.nextAllowedAt = now + config.pollMs;
    return { ok: true, ran: false, reason: 'up_to_date', upstreamMtimeMs, snapshotMtimeMs };
  }

  liveSyncState.lastStartedAt = now;
  liveSyncState.nextAllowedAt = now + config.syncIntervalMs;
  liveSyncState.inFlight = (async () => {
    const startedAt = Date.now();
    try {
      await execFileAsync('/bin/zsh', ['-lc', config.command], {
        timeout: config.syncTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: process.env
      });
      liveSyncState.lastFinishedAt = Date.now();
      liveSyncState.lastOkAt = liveSyncState.lastFinishedAt;
      liveSyncState.lastDurationMs = liveSyncState.lastFinishedAt - startedAt;
      liveSyncState.lastError = '';
      liveSyncState.lastReason = 'synced';
      liveSyncState.runCount += 1;
      return { ok: true, ran: true };
    } catch (err) {
      liveSyncState.lastFinishedAt = Date.now();
      liveSyncState.lastDurationMs = liveSyncState.lastFinishedAt - startedAt;
      liveSyncState.lastError = String(err.stderr || err.message || err);
      liveSyncState.lastReason = 'sync_error';
      liveSyncState.nextAllowedAt = liveSyncState.lastFinishedAt + config.syncFailureBackoffMs;
      return { ok: false, ran: true, error: liveSyncState.lastError };
    } finally {
      liveSyncState.inFlight = null;
    }
  })();

  return liveSyncState.inFlight;
}

async function waitForUpdate(sinceId, config) {
  const deadline = Date.now() + config.waitMs;
  let current = readSnapshotWithMeta();
  await maybeRunLiveSync(config, current.mtimeMs);
  current = readSnapshotWithMeta();
  const currentId = String(Math.floor(current.mtimeMs));
  if (!sinceId || currentId !== sinceId) {
    return { changed: true, id: currentId, ...current };
  }

  while (Date.now() < deadline) {
    await sleep(config.pollMs);
    current = readSnapshotWithMeta();
    await maybeRunLiveSync(config, current.mtimeMs);
    current = readSnapshotWithMeta();
    const id = String(Math.floor(current.mtimeMs));
    if (!sinceId || id !== sinceId) {
      return { changed: true, id, ...current };
    }
  }

  return {
    changed: false,
    id: String(Math.floor(current.mtimeMs)),
    ...current
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const config = liveSyncConfig();
    const sinceId = String(req.headers['last-event-id'] || req.query?.since || '').trim();
    const result = await waitForUpdate(sinceId, config);
    const sync = liveSyncMeta(config, result.snapshot);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write('retry: 1000\n');
    if (result.changed) {
      res.write(`id: ${result.id}\n`);
      res.write('event: snapshot\n');
      res.write(`data: ${JSON.stringify({
        snapshot: result.snapshot,
        generatedAt: result.snapshot?.generatedAt || null,
        mtimeMs: result.mtimeMs,
        version: result.id,
        sync
      })}\n\n`);
    } else {
      res.write('event: heartbeat\n');
      res.write(`data: ${JSON.stringify({
        ok: true,
        version: result.id,
        generatedAt: result.snapshot?.generatedAt || null,
        mtimeMs: result.mtimeMs,
        sync
      })}\n\n`);
    }
    res.end();
  } catch (err) {
    res.status(500).json({ error: 'stream endpoint failed', details: String(err.message || err) });
  }
};
