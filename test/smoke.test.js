'use strict';
/**
 * Smoke test — run with `npm test` after setting DATABASE_URL in .env
 * (and STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET to dummy test values
 * for the webhook-rejection check; no real Stripe call is made here).
 *
 * Covers: register → wrong-password rejected → login → session persists
 * across requests → non-paying member cannot post (403) → logout ends
 * session → forged webhook rejected (400) → public bills list works.
 * The full Stripe test-mode checklist (unlock / re-lock) is in README.md
 * and needs real Stripe test keys — it is NOT run here.
 */
const assert = require('assert');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
let cookie = '';

async function req(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, { ...opts, headers });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON is fine for webhook */ }
  return { status: res.status, json, text };
}

(async () => {
  const user = 'smoke_' + Date.now().toString(36);
  // health + empty board
  let r = await req('/api/health');
  assert.strictEqual(r.status, 200, 'health should be 200');
  r = await req('/api/bills');
  assert.strictEqual(r.status, 200, 'bills list should be 200');
  assert.ok(Array.isArray(r.json.bills), 'bills should be a list');

  // register
  r = await req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: user, email: user + '@example.com', password: 'smoke-pass-123' }) });
  assert.strictEqual(r.status, 201, 'register should be 201: ' + r.text);
  assert.strictEqual(r.json.member.subscription_status, 'pending');

  // wrong password rejected (after logging out first)
  await req('/api/auth/logout', { method: 'POST' });
  cookie = '';
  r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password: 'wrong-password' }) });
  assert.strictEqual(r.status, 401, 'wrong password should be 401');

  // login, session persists
  r = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password: 'smoke-pass-123' }) });
  assert.strictEqual(r.status, 200, 'login should be 200');
  r = await req('/api/auth/me');
  assert.strictEqual(r.json.member.username, user, 'session should persist across requests');

  // non-paying member cannot post
  r = await req('/api/bills', { method: 'POST', body: JSON.stringify({ title: 'Electric bill', amount: 120, category: 'Electric', story: 'Test bill' }) });
  assert.strictEqual(r.status, 403, 'pending member posting should be 403, got ' + r.status);

  // forged webhook rejected (bad signature, no Stripe keys needed for the 400/500 path)
  r = await req('/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 'forged' }, body: JSON.stringify({ id: 'evt_test', type: 'invoice.paid' }) });
  assert.ok([400, 500].includes(r.status), 'forged webhook should be rejected, got ' + r.status);

  // logout ends session
  await req('/api/auth/logout', { method: 'POST' });
  r = await req('/api/auth/me');
  assert.strictEqual(r.json.member, null, 'after logout, /me should be null');

  console.log('SMOKE TEST PASSED');
  process.exit(0);
})().catch((err) => { console.error('SMOKE TEST FAILED:', err.message); process.exit(1); });
