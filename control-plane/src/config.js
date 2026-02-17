const path = require('path');
const fs = require('fs');

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

function firstExistingPath(paths, fallback) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return fallback;
}

function readConfig() {
  const appDir = path.resolve(__dirname, '..');
  const repoDir = path.resolve(appDir, '..');
  const baselineSnapshotPath = String(
    process.env.COMMAND_CENTER_BASELINE_SNAPSHOT_PATH || ''
  ).trim() || firstExistingPath([
    path.join(appDir, 'snapshot.json'),
    path.join(repoDir, 'snapshot.json')
  ], path.join(appDir, 'snapshot.json'));
  const operatorConfigPath = String(
    process.env.COMMAND_CENTER_OPERATOR_CONFIG_PATH || ''
  ).trim() || firstExistingPath([
    path.join(appDir, 'operator.config.json'),
    path.join(repoDir, 'operator.config.json')
  ], path.join(appDir, 'operator.config.json'));
  return {
    rootDir: appDir,
    port: clampNumber(process.env.PORT, 4190, 1, 65535),
    databaseUrl: String(process.env.DATABASE_URL || '').trim(),
    baselineSnapshotPath,
    operatorConfigPath,
    ingestToken: String(process.env.COMMAND_CENTER_INGEST_TOKEN || '').trim(),
    ingestTokenSha256: String(process.env.COMMAND_CENTER_INGEST_TOKEN_SHA256 || '').trim().toLowerCase(),
    adminToken: String(process.env.COMMAND_CENTER_ADMIN_TOKEN || '').trim(),
    sseWaitMs: clampNumber(process.env.COMMAND_CENTER_STREAM_WAIT_MS, 25000, 1000, 30000),
    ssePollMs: clampNumber(process.env.COMMAND_CENTER_STREAM_POLL_MS, 1000, 200, 5000),
    heartbeatEvaluationIntervalMs: clampNumber(
      process.env.COMMAND_CENTER_HEARTBEAT_EVAL_INTERVAL_MS,
      30000,
      1000,
      300000
    ),
    staleAfterMissedHeartbeats: clampNumber(
      process.env.COMMAND_CENTER_STALE_AFTER_MISSED_HEARTBEATS,
      2,
      1,
      20
    ),
    blockStaleApi: envBool('COMMAND_CENTER_BLOCK_STALE_API', false),
    corsOrigin: String(process.env.COMMAND_CENTER_CORS_ORIGIN || '*').trim() || '*'
  };
}

module.exports = {
  readConfig,
  clampNumber,
  envBool
};
