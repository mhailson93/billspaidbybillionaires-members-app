'use strict';
/**
 * Member auth: bcrypt passwords, server-side sessions stored in Postgres.
 * The session cookie holds a random token; only its SHA-256 hash is stored.
 * Cookie: HttpOnly, Secure (in production / when APP_URL is https), SameSite=Lax.
 * 30-day expiry. Logout deletes the session row. Sessions survive a server
 * restart and work in a second tab/window because they live in the DB,
 * not in server memory.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('./db');

const SESSION_DAYS = 30;
const COOKIE_NAME = 'bpb_session';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function cookieOptions() {
  const secure = process.env.NODE_ENV === 'production' || (process.env.APP_URL || '').startsWith('https://');
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  };
}

async function createSession(memberId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions (token_hash, member_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), memberId, expiresAt]
  );
  return { token, expiresAt };
}

async function getMemberFromRequest(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT m.id, m.username, m.email, m.subscription_status, m.stripe_customer_id,
            m.stripe_subscription_id, s.expires_at
       FROM sessions s JOIN members m ON m.id = s.member_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

async function destroySession(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}
async function checkPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = { COOKIE_NAME, SESSION_DAYS, cookieOptions, createSession, getMemberFromRequest, destroySession, hashPassword, checkPassword };
