# Bills Paid by Billionaires — Members App (deployable)

Server-backed members app. Only people posting bills pay **$14.99/month**
(Stripe Poster Membership, live price `price_1Ucv1sPkgBJAsgZQzpgD2FCw`,
payment link https://buy.stripe.com/4gM6oJfe4b5eaVV6zA3Ru01).
Givers browse and offer help for free, no account needed.

## What it does

- **Member accounts** — username + email + bcrypt-hashed password
  (12 rounds), login/logout, username + membership status shown when logged in.
- **Sessions** — server-side, stored in Postgres, 30-day expiry,
  `HttpOnly` / `Secure` (production) / `SameSite=Lax` cookie. Survives a
  server restart and works in a second tab/window. Logout deletes the session.
- **Membership verification** — Stripe webhooks are the source of truth
  (`checkout.session.completed`, `customer.subscription.created/updated/deleted`,
  `invoice.paid`, `invoice.payment_failed`). Signature verified from the raw
  body, event IDs stored in `stripe_events` and processed once only.
  Posting unlocks only for an `active` subscription and re-locks on
  cancellation / past-due. The success URL alone never unlocks posting:
  `/api/membership/confirm` re-checks the Checkout Session server-side.
  Members can also tap **“I Paid — Verify My Membership”**, which looks up
  their Stripe subscription by checkout email.
- **Bills board** — starts empty, fills with real member posts. Public
  listings show an anonymous display name only, “Location kept private”,
  no full names / addresses / phones / emails / account numbers.
  A server-side posting check runs on **every** post attempt.
- **Look** — same flashy gold-and-green style as the original Bills site:
  bold headlines, gold ticker, hero, bills board, how-it-works, giver/poster panels.

## Stack

Node 20+ · Express · Postgres (`pg`) · bcrypt · Stripe · `cookie-parser`.
No framework lock-in; one `src/server.js` serves the API and the static
front end in `public/`.

## Files

| File | What it is |
|---|---|
| `src/server.js` | Express app: auth, sessions, membership, bills, webhook |
| `src/db.js` | Postgres pool + schema bootstrap |
| `src/auth.js` | bcrypt + server-side sessions |
| `src/stripe.js` | Stripe lookup / Checkout verify / status mapping |
| `schema.sql` | Tables: `members`, `sessions`, `bills`, `help_offers`, `stripe_events` |
| `public/index.html` | Gold-and-green front end (login, join, verify, post, board) |
| `render.yaml` | Render Blueprint: $7 web + $6 Postgres = $13/mo |
| `.env.example` | Every env var the app needs (no real secrets) |

## Run locally

```bash
npm install
cp .env.example .env   # fill in a local DATABASE_URL + test Stripe keys
# start Postgres locally, create the database, then:
npm start              # http://localhost:3000
```

The server creates the tables on first start (`src/db.js` runs `schema.sql`).

## Deploy to Render ($13/mo)

1. **Push this folder to GitHub** (new repo, e.g. `billspaidbybillionaires-members-app`).
   Do not commit `.env` — `.gitignore` already excludes it.
2. **Create a Render account**, add a card. In Render: **New → Blueprint**,
   point at the GitHub repo. This creates:
   - Web Service `bills-members-app` — Starter, $7/mo, always on
   - Postgres `bills-db` — Basic, $6/mo, with backups
3. **Set env vars in the Render dashboard** (Environment — never in code):
   - `SESSION_SECRET` — generate a long random string
   - `STRIPE_SECRET_KEY` — start with `sk_test_...`
   - `STRIPE_WEBHOOK_SECRET` — see webhook step below
   - `STRIPE_PRICE_ID` — `price_1Ucv1sPkgBJAsgZQzpgD2FCw` (already in `render.yaml`)
   - `APP_URL` — your Render address, e.g. `https://bills-members-app.onrender.com`
   - `DATABASE_URL` — filled automatically from the Render database
4. **Stripe webhook** — in the Stripe Dashboard, add an endpoint:
   - URL: `https://<your-app>.onrender.com/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`,
     `invoice.paid`, `invoice.payment_failed`
   - Copy the signing secret (`whsec_...`) into Render as `STRIPE_WEBHOOK_SECRET`.
   - Use **test mode** first (test keys + a test webhook), then create the
     live webhook and switch the keys to live.
5. **Domain (later, optional)** — launch on the free `*.onrender.com`
   address. To use a `.com` (~$10–15/yr), buy it, add it in Render →
   Custom Domain, add the DNS CNAME Render gives you. SSL is automatic.
   The existing Netlify/GitHub Pages addresses point at the *static* site
   only and cannot serve this app.

## Test-mode checklist (do this before any live payment)

- [ ] Register an account, log in, log out, log back in — wrong password is rejected.
- [ ] Create a **test-mode** Stripe subscription for the test member
      (test price + test Checkout) — posting unlocks only after verification.
- [ ] A non-paying / pending member gets a 403 when trying to post.
- [ ] Cancel the test subscription in Stripe — the webhook re-locks posting.
- [ ] Restart the server — the session is still valid (it lives in Postgres).
- [ ] Open the app in a second tab/window — still logged in, no re-pay.
- [ ] Send a **forged** webhook (wrong signature) — it is rejected with 400.
- [ ] Send the same webhook event twice — it is processed once only.
- [ ] Switch env vars to **live** keys + live webhook secret only after all
      of the above pass. A real paid $14.99 member is the first true live test.

## Gaps / still needed from Mike

- **Render account + card** ($13/mo) — not created here.
- **GitHub repo push** — this code is local only until pushed.
- **Stripe test keys, then live keys** — never put them in code or chat;
  set them in Render env vars only.
- **Password reset email** — not built yet. A member who forgets their
  password is locked out until a reset flow (e.g. Resend/SendGrid free tier)
  is added. Budget it before launch, not after.
- **Privacy policy / terms / refund & cancellation policy** — must be on
  the site before taking real money (the launch plan flags money-transmission
  / 1099-K / not-a-charity issues for a lawyer — this is not legal advice).
- **First live paid member test** — the Verify flow is wired, but no live
  $14.99 subscription has been tested end-to-end yet.
