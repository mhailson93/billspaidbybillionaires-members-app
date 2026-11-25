'use strict';
/**
 * Stripe helpers. All keys come from env vars only — never in code.
 * Live product (already created in the Hailsons Hood-Duct Exhaust account):
 *   Poster Membership, $14.99/month, price_1Ucv1sPkgBJAsgZQzpgD2FCw
 *   Payment link: https://buy.stripe.com/4gM6oJfe4b5eaVV6zA3Ru01
 * In test mode, set STRIPE_SECRET_KEY to a sk_test_... key and
 * STRIPE_PRICE_ID to the matching test price; the payment link above
 * is the LIVE link and must not be used for test-mode checks.
 */
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1Ucv1sPkgBJAsgZQzpgD2FCw';
const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/4gM6oJfe4b5eaVV6zA3Ru01';

let stripe = null;
function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

/** Map a Stripe subscription status to our member subscription_status. */
function mapSubscriptionStatus(stripeStatus) {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'past_due';
  if (stripeStatus === 'canceled' || stripeStatus === 'incomplete_expired') return 'cancelled';
  return 'pending';
}

/**
 * Look up a member's subscription by checkout email.
 * Finds the Stripe customer by email, then their subscription to our price.
 * Returns { status, subscriptionId, customerId } or { status: 'pending' }.
 * Used by the "I Paid — Verify My Membership" flow.
 */
async function lookupSubscriptionByEmail(email) {
  const s = getStripe();
  if (!s) throw new Error('STRIPE_SECRET_KEY is not configured');
  const customers = await s.customers.list({ email, limit: 1 });
  if (!customers.data.length) return { status: 'pending', subscriptionId: null, customerId: null };
  const customer = customers.data[0];
  const subs = await s.subscriptions.list({ customer: customer.id, status: 'all', limit: 10 });
  const match = subs.data.find((sub) =>
    sub.items.data.some((item) => item.price && item.price.id === STRIPE_PRICE_ID)
  );
  if (!match) return { status: 'pending', subscriptionId: null, customerId: customer.id };
  return {
    status: mapSubscriptionStatus(match.status),
    subscriptionId: match.id,
    customerId: customer.id,
    stripeStatus: match.status,
  };
}

/**
 * Verify a Checkout Session server-side (for the /membership/confirm return page).
 * Never unlock posting from the success URL alone — always check the session
 * with Stripe using the secret key, then confirm the subscription is active.
 */
async function verifyCheckoutSession(sessionId) {
  const s = getStripe();
  if (!s) throw new Error('STRIPE_SECRET_KEY is not configured');
  const session = await s.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') return { paid: false, status: 'pending' };
  let subscription = null;
  if (session.subscription) {
    subscription = await s.subscriptions.retrieve(session.subscription);
  }
  return {
    paid: true,
    status: subscription ? mapSubscriptionStatus(subscription.status) : 'pending',
    subscriptionId: subscription ? subscription.id : null,
    customerId: session.customer || null,
    customerEmail: session.customer_details ? session.customer_details.email : null,
  };
}

module.exports = { STRIPE_PRICE_ID, STRIPE_PAYMENT_LINK, getStripe, mapSubscriptionStatus, lookupSubscriptionByEmail, verifyCheckoutSession };
