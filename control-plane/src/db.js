const { Pool } = require('pg');

let pool = null;

async function ensureSearchPath(client) {
  if (client.__ccSearchPathReady) return;
  await client.query('SET search_path TO command_center, public');
  client.__ccSearchPathReady = true;
}

function getPool(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for control-plane service.');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
}

async function query(text, params = [], databaseUrl) {
  const p = getPool(databaseUrl);
  const client = await p.connect();
  try {
    await ensureSearchPath(client);
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function withTx(databaseUrl, fn) {
  const p = getPool(databaseUrl);
  const client = await p.connect();
  try {
    await ensureSearchPath(client);
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  query,
  withTx
};
