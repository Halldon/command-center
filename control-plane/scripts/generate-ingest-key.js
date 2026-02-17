#!/usr/bin/env node
require('dotenv').config();

const crypto = require('crypto');
const { readConfig } = require('../src/config');
const { withTx } = require('../src/db');

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseArgs(argv) {
  const out = {
    projectId: '',
    keyId: ''
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-id') out.projectId = String(argv[i + 1] || '').trim();
    if (arg === '--key-id') out.keyId = String(argv[i + 1] || '').trim();
  }
  return out;
}

async function main() {
  const cfg = readConfig();
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is required.');
  const args = parseArgs(process.argv.slice(2));
  const token = randomToken();
  const keyId = args.keyId || `key_${Date.now()}`;
  const projectId = args.projectId || null;
  const hash = hashToken(token);

  await withTx(cfg.databaseUrl, async (client) => {
    if (projectId) {
      const project = await client.query('SELECT project_id FROM project_adapters WHERE project_id = $1 LIMIT 1', [projectId]);
      if (!project.rowCount) {
        throw new Error(`Unknown project_id "${projectId}"`);
      }
    }
    await client.query(
      `
      INSERT INTO ingest_keys (key_id, project_id, secret_hash, active, created_at)
      VALUES ($1, $2, $3, TRUE, now())
      ON CONFLICT (key_id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        secret_hash = EXCLUDED.secret_hash,
        active = TRUE,
        rotated_at = now()
      `,
      [keyId, projectId, hash]
    );
  });

  console.log(JSON.stringify({
    keyId,
    projectId,
    token,
    tokenSha256: hash
  }, null, 2));
}

main().catch((err) => {
  console.error('[gen:key] failed', err.message || err);
  process.exit(1);
});
