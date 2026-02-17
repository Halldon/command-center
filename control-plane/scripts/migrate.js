#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { query } = require('../src/db');
const { readConfig } = require('../src/config');

async function main() {
  const config = readConfig();
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }
  const schemaPath = path.join(__dirname, '..', 'src', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await query(sql, [], config.databaseUrl);
  console.log('[migrate] schema applied');
}

main().catch((err) => {
  console.error('[migrate] failed', err.message || err);
  process.exit(1);
});
