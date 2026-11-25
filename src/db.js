'use strict';
/**
 * Postgres connection + schema bootstrap.
 * Requires DATABASE_URL (Render supplies it; locally use the
 * postgres:// URL in .env, e.g. postgres://bills:bills@localhost:5432/bills).
 * No secret is ever hard-coded here.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required (see .env.example)');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres requires SSL in production; locally it is harmless to allow it.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 10,
});

let schemaReady = null;
async function initSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      // gen_random_uuid() needs pgcrypto on older Postgres; harmless on PG 13+.
      await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await pool.query('CREATE EXTENSION IF NOT EXISTS citext');
      const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
      await pool.query(sql);
    })();
  }
  return schemaReady;
}

module.exports = { pool, initSchema };
