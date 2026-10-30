# nextjs-stripe-billing-starter

A Next.js (App Router, TypeScript) billing starter that concentrates on the part that costs money when it is wrong: the payment path. Stripe Checkout with Stripe Tax, the Billing Portal, and a webhook pipeline that verifies signatures, applies every event once, and cannot be rolled back by late deliveries.

- **Checkout** (`POST /api/checkout`): subscription-mode Session with `automatic_tax`, required billing address, tax ID collection, and one reused Stripe customer per app user.
- **Billing Portal** (`POST /api/portal`).
- **Webhook** (`POST /api/stripe/webhook`): raw-body signature verification, event-id idempotency, timestamp-ordered state, handlers for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.payment_failed`.
- **Entitlement** (`GET /api/entitlement`): a pure domain function maps Stripe subscription status to `free` / `pro`, with a configurable grace period for `past_due`.
- **Storage** behind a small `BillingRepository` interface, with in-memory and SQLite (`node:sqlite`, no native addon) implementations.
- The Stripe client is injected, so the whole payment path is tested offline with a fake client and real signed payloads.

## Architecture

```
Browser --POST /api/checkout--> Stripe Checkout Session (subscription, tax, billing address)
   |                                   |
   | redirected back to APP_URL        | customer pays on Stripe's page
   | (grants nothing)                  v
   |                            Stripe --signed event--> POST /api/stripe/webhook
   |                                                       1. verify signature on the raw body
   |                                                       2. skip if this event id was already processed
   |                                                       3. plan changes (may fetch the subscription from Stripe)
   |                                                       4. commit: event id + changes, one transaction,
   |                                                          older state never overwrites newer state
   v                                                       v
GET /api/entitlement <-- resolveEntitlement(status, ...) <-- BillingRepository (memory | SQLite)
```

Returning from Checkout does not grant access. Only the signed webhook changes what a user is entitled to.

### Why idempotency matters

Stripe delivers webhooks at least once and retries failed deliveries (up to three days with exponential backoff in live mode). Any handler that is not idempotent eventually applies one event twice. Here the event id is recorded in the same transaction as the state change (`BillingRepository.commitEvent`):

- With SQLite, a crash after the change but before the marker is impossible: both commit together or neither does.
- If handling fails, nothing is recorded and the response is `500`, so Stripe's retry is processed from scratch.
- Two concurrent deliveries of the same event race on the marker; exactly one applies, the other answers `duplicate`.

### Why ordering matters

Stripe does not guarantee delivery order. A `customer.subscription.updated` (status `active`) that arrives after `customer.subscription.deleted` would resurrect a cancelled subscription, and a stale `past_due` arriving after `active` would lock out a paying customer. Every stored subscription carries `stateAsOf`, the time its state is current as of, and input older than that is ignored (`staleEffects` in the response, a log line on the server).

- Webhook payloads are stamped with `event.created`.
- State this app fetched itself (`checkout.session.completed` retrieves the subscription) is stamped with the time of the fetch, because it is newer than the event that triggered it.
- Stripe's docs point out that `created` has one-second resolution, so two distinct events can share a timestamp, and they recommend handlers that do not depend on order. On a tie with the stored state this app does not guess: it asks Stripe for the current subscription and stores that.
- The tests deliver three subscription events in all six possible orders and assert the same final state each time.

## Quick start

Requirements: Node.js 24, a Stripe account (test mode is fine), and optionally the [Stripe CLI](https://docs.stripe.com/stripe-cli).

```bash
npm install
cp .env.example .env.local   # then fill in the Stripe values, see the table below
npm run dev                  # http://localhost:3000
```

Stripe-side setup (test mode first):

1. Create a product with two recurring prices (monthly and yearly) and put their ids in `STRIPE_PRICE_PRO_MONTHLY` and `STRIPE_PRICE_PRO_YEARLY`.
2. Configure the Customer Portal in the Dashboard (sandbox and live mode are configured separately), including the **Tax ID** toggle if customers should manage their tax IDs there.
3. Work through the [Stripe Tax setup checklist](#stripe-tax-setup-checklist).
4. Forward webhooks to your local server:

   ```bash
   stripe listen \
     --events checkout.session.completed,customer.subscription.updated,customer.subscription.deleted,invoice.payment_failed \
     --forward-to localhost:3000/api/stripe/webhook
   ```

   The CLI prints `Ready! Your webhook signing secret is whsec_...`. Put that value in `STRIPE_WEBHOOK_SECRET` and restart `npm run dev` (environment files are read at startup).
5. Open the app, click **Subscribe**, and pay with a Stripe test card. After the redirect back, click **Check entitlement**; it flips to `pro` once the webhook has been processed.

In production, create a webhook endpoint in the Dashboard pointing at `https://<your-domain>/api/stripe/webhook`, subscribe it to the same four events, and use its signing secret.

API version: payload shapes follow the API version of the webhook endpoint. The code reads `invoice.parent.subscription_details.subscription` and the billing period from `items.data[].current_period_end`, as typed by the pinned SDK (`stripe@23`, API version `2026-09-30.endive`). Create the endpoint on that version if your account default is older.

### Try it without Stripe

`scripts/send-test-event.mjs` signs and sends subscription and payment-failure events to your running dev server, which is enough to watch idempotency, ordering and the grace period work. It reads `STRIPE_WEBHOOK_SECRET` from `.env.local`; any `whsec_...` value works locally. The demo user is `demo-user-1`, sent as a header because `ALLOW_DEMO_AUTH=true` is set in `.env.example`.

```bash
ent() { curl -s localhost:3000/api/entitlement -H 'x-demo-user-id: demo-user-1'; echo; }
now=$(date +%s)

ent                                                                                    # free, no_subscription
npm run webhook:send -- --status active --id evt_demo_1 --created $now                 # processed
ent                                                                                    # pro, active
npm run webhook:send -- --status active --id evt_demo_1 --created $now                 # duplicate, nothing changes
npm run webhook:send -- --status past_due --id evt_demo_2 --created $((now + 60))      # processed
ent                                                                                    # pro, past_due_in_grace
npm run webhook:send -- --status active --id evt_demo_3 --created $((now + 30))        # staleEffects: 1, state unchanged
npm run webhook:send -- --type invoice.payment_failed --created $((now + 61))          # recorded on the subscription
npm run webhook:send -- --type customer.subscription.deleted --created $((now + 120))  # processed
ent                                                                                    # free, inactive_status
```

Event ids are remembered, so use fresh `--id` values (or delete `data/billing.db`) to run the sequence again. Do not send two events for the same subscription with the same `--created` second: the app resolves such ties by asking Stripe, which does not know the demo subscription, and answers `500`.

`checkout.session.completed` is not supported by the script because handling it fetches the subscription from Stripe; exercise it with a real test-mode checkout.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | yes | | Secret or restricted key; must start with `sk_` or `rk_`. |
| `STRIPE_WEBHOOK_SECRET` | yes | | Webhook signing secret; must start with `whsec_`. |
| `STRIPE_PRICE_PRO_MONTHLY` | yes | | Price id for `{"plan":"monthly"}`; must start with `price_`. |
| `STRIPE_PRICE_PRO_YEARLY` | yes | | Price id for `{"plan":"yearly"}`. |
| `APP_URL` | no | `http://localhost:3000` | Base URL for Checkout success/cancel and Portal return URLs. |
| `PAST_DUE_GRACE_DAYS` | no | `7` | Days a `past_due` subscription keeps pro access. Fractions allowed, `0` disables the grace period. |
| `BILLING_STORE` | no | `sqlite` | `sqlite` or `memory` (the in-memory store loses state on restart). |
| `DATABASE_PATH` | no | `./data/billing.db` | SQLite file; parent directories are created. |
| `ALLOW_DEMO_AUTH` | no | unset | `true` trusts the `x-demo-user-id` / `x-demo-user-email` headers. Local demo only. |

Invalid or missing values do not crash the server: every API route answers `500 {"error":"billing_not_configured"}` and the server log lists each problem.

## API

All responses are JSON with `Cache-Control: no-store`.

| Route | Success | Errors |
| --- | --- | --- |
| `POST /api/checkout` body `{"plan":"monthly"\|"yearly"}` | `200 {"url"}`: redirect the browser there | `400` bad body or unknown plan, `401`, `409 already_subscribed` (use the portal), `502 stripe_error` |
| `POST /api/portal` | `200 {"url"}` | `401`, `404 no_billing_account` (never started checkout), `502 stripe_error` |
| `GET /api/entitlement` | `200 {"plan","reason","graceEndsAt","currentPeriodEnd","cancelAt","lastPaymentFailedAt"}` | `401` |
| `POST /api/stripe/webhook` | `200 {"received":true,"outcome":"processed"\|"duplicate"\|"ignored"}` | `400` missing or invalid signature, `500 processing_failed` (Stripe will retry) |

Clients never send price ids; the plan key is mapped to a price on the server.

### Checkout Session parameters

```ts
{
  mode: 'subscription',
  customer: <stored Stripe customer for this user>,
  client_reference_id: user.id,
  automatic_tax: { enabled: true },
  billing_address_collection: 'required',
  tax_id_collection: { enabled: true },
  customer_update: { address: 'auto', name: 'auto' },
  subscription_data: { metadata: { user_id: user.id } },
  ...
}
```

`customer_update` is there because an existing customer is passed: per Stripe's docs, tax ID collection on an existing customer needs `customer_update.name = 'auto'`, and using the billing address entered in Checkout for tax calculation needs `customer_update.address = 'auto'`. `subscription_data.metadata.user_id` lets the webhook attribute a subscription to a user even if the event arrives before the customer link is stored.

The customer is created on the first checkout with `metadata.user_id` and an idempotency key (`billing-customer-<userId>`), stored, and reused afterwards. If two first checkouts race, the first stored link wins and both Sessions use it.

## Entitlement rules

Implemented in `src/domain/entitlement.ts`, with no Stripe or I/O dependencies.

| Subscription status | Plan |
| --- | --- |
| `active`, `trialing` | `pro` |
| `past_due` | `pro` until `PAST_DUE_GRACE_DAYS` after it became past due; `free` from that instant on (the end is exclusive) |
| `canceled`, `unpaid`, `paused`, `incomplete`, `incomplete_expired`, any unknown status | `free` |
| no subscription | `free` |

The grace clock starts when the subscription enters `past_due` and does not restart on Stripe's payment retries. A user with several subscription rows (cancelled, then resubscribed) is `pro` if any of them is. While a subscription is `active`, `trialing`, `past_due`, `unpaid` or `paused`, a new Checkout is refused with `409` so a customer cannot end up with two parallel subscriptions.

## Webhook handling

| Event | Effect |
| --- | --- |
| `checkout.session.completed` | For `mode: subscription` sessions with a `client_reference_id`: link user and customer, fetch the subscription from Stripe, store it. Other sessions are acknowledged and ignored. |
| `customer.subscription.updated` | Store the new status, price, period end and scheduled cancellation, unless the stored state is newer. |
| `customer.subscription.deleted` | Store the subscription as `canceled`. |
| `invoice.payment_failed` | Record the time and invoice id on the subscription (exposed as `lastPaymentFailedAt`). It does not change entitlement by itself: the status change arrives as `customer.subscription.updated`. Invoices without a subscription are ignored. |
| anything else | `200`, ignored, not recorded. |

The owner of a subscription event is the user linked to its Stripe customer, falling back to `subscription.metadata.user_id`. Events that match neither are acknowledged and logged, not retried, so subscriptions that belong to other products on the same Stripe account cannot wedge the endpoint.

## Storage

`src/billing/types.ts` defines `BillingRepository`. The important method is `commitEvent(event, effects)`: record the event id and apply the effects atomically, or report a duplicate. Both implementations share one effect-application module (`src/billing/apply-effects.ts`), and `tests/repository.test.ts` runs the same contract suite against each.

- `InMemoryBillingRepository`: for tests and quick experiments.
- `SqliteBillingRepository`: Node's built-in `node:sqlite`, WAL mode, `BEGIN IMMEDIATE` transactions. Node 24 prints an `ExperimentalWarning` for SQLite when it loads. It is a single-file, single-node store; for several instances implement `BillingRepository` on Postgres. The `stripe_events` table has no retention job.

## Authentication

Billing needs to know who is signed in, and this repository deliberately does not pick an auth library. `src/lib/auth.ts` defines `AuthResolver = (request) => Promise<{ id, email? } | null>`. By default nobody is signed in and every user-facing route answers `401`. Wire your session lookup in `src/lib/container.ts` (the `auth:` line), replacing `denyAll`. `ALLOW_DEMO_AUTH=true` swaps in header-based auth for local development: anyone can send those headers, so never enable it where real users can reach the app.

## Stripe Tax setup checklist

`automatic_tax` only works once Stripe Tax is set up on the Stripe account. From Stripe's [Stripe Tax setup guide](https://docs.stripe.com/tax/set-up) and [Checkout tax guide](https://docs.stripe.com/tax/checkout/page):

- [ ] Activate Stripe Tax on the [Tax settings page](https://dashboard.stripe.com/settings/tax) of the Dashboard.
- [ ] Confirm your head office (origin) address there. It defaults to your Stripe business address.
- [ ] Choose a preset product tax code, then check every product in the catalog has the tax code that fits what you sell (`tax_code` on the Product).
- [ ] Decide the default tax behavior for prices: exclusive (tax added on top), inclusive, or automatic (exclusive for USD and CAD, inclusive for other currencies).
- [ ] Add your tax registrations (Dashboard, Tax, Registrations). Without a registration covering the customer's location, the calculation returns zero tax.
- [ ] Enable tax collection in the integration: this repository sets `automatic_tax.enabled = true` on every Checkout Session. Enabling Stripe Tax does not retroactively update existing subscriptions; each of those needs `automatic_tax.enabled = true` set on it.
- [ ] If you sell to businesses, keep `tax_id_collection` enabled. Checkout collects business tax IDs only, checks their format but not their validity, and does not show the form again to a customer who already has a saved tax ID.
- [ ] Test with Stripe's [tax testing guide](https://docs.stripe.com/tax/testing); the calculated amount is `total_details.amount_tax` on the Checkout Session.
- [ ] When you go live, switch to live-mode API keys and a live webhook endpoint, which has its own signing secret.

## Tests

```bash
npm run typecheck
npm test
```

No network access and no Stripe keys are needed. The Stripe client is injected: tests pass a fake for API calls and keep the SDK's real `webhooks` helper, so payloads are signed with `stripe.webhooks.generateTestHeaderString` and verified by the real `constructEvent`.

| File | Covers |
| --- | --- |
| `tests/entitlement.test.ts` | Status mapping and grace-period boundaries (one second before the end, exactly at the end, zero and fractional grace days, unknown start time, several subscriptions per user). |
| `tests/webhook.test.ts` | Missing, wrong-secret, tampered, stale-timestamp and non-JSON payloads return `400`. Duplicate and concurrently racing events are applied once. A failed handler leaves the event unrecorded so the retry succeeds. Late events do not downgrade newer state (all six delivery orders converge). Same-second ties are resolved by asking Stripe. Each handled event type. |
| `tests/checkout.test.ts` | Exact Checkout Session parameters including the tax options, customer creation and reuse, server-side prices, `409` for a live subscription, Stripe failures mapped to `502` without leaking details, Portal and entitlement routes. |
| `tests/repository.test.ts` | One contract suite for both repositories (ordering, duplicates, past-due clock, payment failures, atomic rollback), plus SQLite persistence across reopen and rollback after a mid-transaction failure. |
| `tests/routes.test.ts` | The real route modules over a SQLite file: checkout, signed webhook activation, portal, cancellation, user isolation, behaviour when configuration is missing. |
| `tests/config.test.ts`, `tests/mapping.test.ts` | Environment validation, auth resolvers, Stripe object mapping. |

What the automated tests do not cover: a live round-trip against Stripe's servers (real Checkout page, real Portal, real tax calculation). Use the quick start with your test-mode account for that.

## Project layout

```
src/
  domain/entitlement.ts        pure status -> plan mapping
  billing/
    types.ts                   records, effects, BillingRepository
    apply-effects.ts           ordering, past-due clock, payment-failure rules (shared by both stores)
    memory-repository.ts
    sqlite-repository.ts
    stripe-mapping.ts          Stripe subscription -> stored snapshot
    deps.ts                    injected dependencies (BillingStripe, logger, clock, ...)
    handlers/                  checkout, portal, entitlement, webhook: plain (Request, deps) => Response
  lib/                         config, auth, env wiring (container.ts), http helpers
  app/api/**/route.ts          thin Next.js route files
  app/page.tsx                 local demo page
scripts/send-test-event.mjs    signed local webhook sender
tests/
```

## License

MIT, see [LICENSE](LICENSE).
