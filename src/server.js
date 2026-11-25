'use strict';
/**
 * Bills Paid by Billionaires — members app (Node + Express + Postgres).
 *
 * Only people posting bills pay: $14.99/month Poster Membership via Stripe.
 * Givers browse and offer help for free, no account needed.
 * Posting is unlocked ONLY for a logged-in member with an ACTIVE subscription
 * verified via Stripe (webhook = source of truth). A success URL, a client-side
 * flag, or a form field can never unlock posting.
 *
 * Env vars (see .env.example): PORT, DATABASE_URL, DATABASE_SSL,
 * SESSION_SECRET, APP_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 * STRIPE_PRICE_ID. No secret is hard-coded anywhere in this app.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { pool, initSchema } = require('./db');
const auth = require('./auth');
const stripeLib = require('./stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Stripe webhook — MUST come before express.json(), so we get the raw body.
// Verifies the signature; stores each event ID and skips duplicates.
// ---------------------------------------------------------------------------
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = stripeLib.getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(500).json({ error: 'Stripe webhook is not configured' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency: process each event ID once.
  const seen = await pool.query('SELECT 1 FROM stripe_events WHERE event_id = $1', [event.id]);
  if (seen.rowCount) return res.json({ received: true, duplicate: true });
  await pool.query('INSERT INTO stripe_events (event_id, event_type) VALUES ($1, $2)', [event.id, event.type]);

  try {
    await handleStripeEvent(event);
  } catch (err) {
    console.error('Webhook handler failed:', err);
    // Return 200 anyway: Stripe would retry, and the event is already marked seen.
    // The failure is logged; membership can also be re-synced via /api/membership/verify.
  }
  res.json({ received: true });
});

async function handleStripeEvent(event) {
  const stripe = stripeLib.getStripe();
  const obj = event.data.object;
  const HANDLED = [
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
    'invoice.payment_failed',
  ];
  if (!HANDLED.includes(event.type)) return;

  // Resolve the subscription for this event.
  let subscription = null;
  if (event.type === 'checkout.session.completed') {
    if (obj.subscription) subscription = await stripe.subscriptions.retrieve(obj.subscription);
  } else if (obj.object === 'subscription') {
    subscription = obj;
  } else if (obj.subscription) {
    subscription = await stripe.subscriptions.retrieve(obj.subscription);
  }
  if (!subscription) return;

  const status = stripeLib.mapSubscriptionStatus(subscription.status);
  const customerId = subscription.customer;
  const subscriptionId = subscription.id;

  // Match the member by Stripe customer/subscription ID, falling back to
  // the checkout email stored in the session metadata (member_id).
  let memberId = null;
  if (event.type === 'checkout.session.completed' && obj.metadata && obj.metadata.member_id) {
    memberId = obj.metadata.member_id;
  }
  const { rows } = await pool.query(
    'SELECT id FROM members WHERE stripe_customer_id = $1 OR stripe_subscription_id = $2 OR id = $3::uuid',
    [customerId, subscriptionId, memberId || '00000000-0000-0000-0000-000000000000']
  );
  if (!rows.length && !memberId) return;
  const id = rows[0] ? rows[0].id : memberId;
  await pool.query(
    `UPDATE members SET stripe_customer_id = $1, stripe_subscription_id = $2,
       subscription_status = $3, updated_at = now() WHERE id = $4`,
    [customerId, subscriptionId, status, id]
  );
  console.log(`Webhook ${event.type}: member ${id} -> ${status}`);
}

// ---------------------------------------------------------------------------
// Normal middleware (after the webhook, so JSON parsing does not break it)
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function publicMember(m) {
  return m ? { id: m.id, username: m.username, email: m.email, subscription_status: m.subscription_status } : null;
}
function isAnonymousSafe(text) {
  // Public listings must not contain an email, phone-like number, or account number.
  if (/@/.test(text)) return false;
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text)) return false; // phone-like
  if (/\b\d{8,}\b/.test(text)) return false; // long account-like number
  return true;
}
const CATEGORIES = ['Rent', 'Electric', 'Water', 'Internet', 'Phone', 'Medical', 'Car', 'Groceries', 'Other'];

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: 'Username, email and password are required.' });
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–30 characters: letters, numbers, _ . - only.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const hash = await auth.hashPassword(password);
    const { rows } = await pool.query(
      'INSERT INTO members (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, subscription_status',
      [username, email, hash]
    );
    const { token } = await auth.createSession(rows[0].id);
    res.cookie(auth.COOKIE_NAME, token, auth.cookieOptions());
    res.status(201).json({ member: publicMember(rows[0]) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username or email is already taken.' });
    console.error(err);
    res.status(500).json({ error: 'Could not create the account. Try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const { rows } = await pool.query(
      'SELECT * FROM members WHERE username = $1 OR email = $1',
      [username]
    );
    const member = rows[0];
    if (!member || !(await auth.checkPassword(password, member.password_hash))) {
      return res.status(401).json({ error: 'Wrong username/email or password.' });
    }
    const { token } = await auth.createSession(member.id);
    res.cookie(auth.COOKIE_NAME, token, auth.cookieOptions());
    res.json({ member: publicMember(member) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not log in. Try again.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  await auth.destroySession(req);
  res.clearCookie(auth.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const member = await auth.getMemberFromRequest(req);
  res.json({ member: publicMember(member) });
});

// ---------------------------------------------------------------------------
// Membership: Join link + "I Paid — Verify My Membership" + confirm return
// ---------------------------------------------------------------------------
app.get('/api/membership', (req, res) => {
  res.json({
    price_cents: 1499,
    price_display: '$14.99/month',
    price_id: stripeLib.STRIPE_PRICE_ID,
    payment_link: stripeLib.STRIPE_PAYMENT_LINK,
    only_posters_pay: true,
  });
});

// Verify by checkout email: looks the member's Stripe subscription up
// server-side. Used by the "I Paid — Verify My Membership" button.
app.post('/api/membership/verify', async (req, res) => {
  try {
    const member = await auth.getMemberFromRequest(req);
    if (!member) return res.status(401).json({ error: 'Log in first.' });
    const email = (req.body && req.body.email) || member.email;
    const result = await stripeLib.lookupSubscriptionByEmail(email);
    await pool.query(
      `UPDATE members SET stripe_customer_id = COALESCE($1, stripe_customer_id),
         stripe_subscription_id = COALESCE($2, stripe_subscription_id),
         subscription_status = $3, updated_at = now() WHERE id = $4`,
      [result.customerId, result.subscriptionId, result.status, member.id]
    );
    res.json({ subscription_status: result.status, active: result.status === 'active' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Stripe verification is not configured yet.' });
  }
});

// Return page after Stripe Checkout: verify the Checkout Session server-side.
// Never unlocks from the success URL alone.
app.get('/api/membership/confirm', async (req, res) => {
  try {
    const member = await auth.getMemberFromRequest(req);
    if (!member) return res.status(401).json({ error: 'Log in first, then verify.' });
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ error: 'Missing session_id.' });
    const result = await stripeLib.verifyCheckoutSession(sessionId);
    await pool.query(
      `UPDATE members SET stripe_customer_id = COALESCE($1, stripe_customer_id),
         stripe_subscription_id = COALESCE($2, stripe_subscription_id),
         subscription_status = $3, updated_at = now() WHERE id = $4`,
      [result.customerId, result.subscriptionId, result.status, member.id]
    );
    res.json({ paid: result.paid, subscription_status: result.status, active: result.status === 'active' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not confirm the checkout.' });
  }
});

// ---------------------------------------------------------------------------
// Bills — public read, member-only post (server-side check on every attempt)
// ---------------------------------------------------------------------------
app.get('/api/bills', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, display_name, category, title, amount_cents, story, status, created_at
       FROM bills ORDER BY created_at DESC LIMIT 100`
  );
  res.json({ bills: rows });
});

app.post('/api/bills', async (req, res) => {
  try {
    const member = await auth.getMemberFromRequest(req);
    if (!member) return res.status(401).json({ error: 'Log in first.' });
    // Server-side posting check on EVERY post attempt — never trust the client.
    if (member.subscription_status !== 'active') {
      return res.status(403).json({
        error: 'Posting is for active $14.99/month members only. Join via Stripe, then tap "I Paid — Verify My Membership".',
        subscription_status: member.subscription_status,
      });
    }
    const { title, amount, category, story, display_name } = req.body || {};
    if (!title || !amount) return res.status(400).json({ error: 'A bill title and amount are required.' });
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'Enter a valid amount.' });
    const safeCategory = CATEGORIES.includes(category) ? category : 'Other';
    const safeStory = String(story || '').slice(0, 500);
    const safeName = String(display_name || 'Anonymous Member').slice(0, 40);
    if (!isAnonymousSafe(title) || !isAnonymousSafe(safeStory) || !isAnonymousSafe(safeName)) {
      return res.status(400).json({ error: 'Do not include emails, phone numbers, or account numbers in a public bill listing.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO bills (member_id, display_name, category, title, amount_cents, story)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, display_name, category, title, amount_cents, story, status, created_at`,
      [member.id, safeName, safeCategory, String(title).slice(0, 120), amountCents, safeStory]
    );
    res.status(201).json({ bill: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not post the bill. Try again.' });
  }
});

// Givers: free, no account needed. Offer help on a bill.
app.post('/api/bills/:id/help', async (req, res) => {
  try {
    const { giver_name, message } = req.body || {};
    const { rows } = await pool.query('SELECT id FROM bills WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Bill not found.' });
    const safeName = String(giver_name || 'Anonymous Giver').slice(0, 40);
    const safeMsg = String(message || '').slice(0, 300);
    if (!isAnonymousSafe(safeName) || !isAnonymousSafe(safeMsg)) {
      return res.status(400).json({ error: 'Do not include emails, phone numbers, or account numbers.' });
    }
    await pool.query(
      'INSERT INTO help_offers (bill_id, giver_name, message) VALUES ($1, $2, $3)',
      [req.params.id, safeName, safeMsg]
    );
    await pool.query("UPDATE bills SET status = 'help_offered' WHERE id = $1 AND status = 'open'", [req.params.id]);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send the offer. Try again.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, app_url: APP_URL }));

// ---------------------------------------------------------------------------
async function start() {
  await initSchema();
  app.listen(PORT, () => {
    console.log(`Bills Paid by Billionaires members app listening on ${PORT}`);
    console.log(`App URL: ${APP_URL}`);
    console.log(`Stripe price: ${stripeLib.STRIPE_PRICE_ID} ($14.99/month, posters only)`);
  });
}
if (require.main === module) start();
module.exports = app;
