# Billing review checklist: an existing Stripe subscription or membership setup

A checklist for a **read-only review** of a Stripe billing setup that is already running: what to look at, how to look at it without changing anything, and what a sound answer looks like. It is organised around the places where billing code costs money when it is wrong.

This repository is a starter, not an auditor: it does not inspect anyone's Stripe account. It is useful here as a reference implementation. The last column of each table says what **this starter does**, so you can compare an existing setup with a design where the answer is known and tested, and see where the starter itself stops. "Not implemented" means exactly that: the starter has no code for it, and you would have to build or configure it.

## Scope and access for a read-only review

- Stripe Dashboard access with a read-only role (or screen-share), for **test and live** mode. Live API keys do not need to be shared; if a key is unavoidable, a restricted key with read permissions only, revoked afterwards.
- The repository, read-only: checkout, portal, webhook handler, the code that decides who has access, the database tables that hold subscription state, and the job or script that backfills or reconciles.
- No production changes during the review. Replays and experiments run in test mode, against a copy.
- Credentials travel in a password manager, never in chat or tickets.

## 1. Keys, accounts and environments

| Check | Sound looks like | How to look | This starter |
| --- | --- | --- | --- |
| Test and live are separated | Different keys, webhook endpoints and signing secrets, prices, portal configuration and tax registrations per mode; nothing shared | Dashboard in both modes; the deployment's environment variables per environment | The environment variables are read once at startup; nothing tells test from live. Only the key prefix (`sk_` or `rk_`) and the `whsec_` and `price_` prefixes are validated, so a live key in a development environment is accepted. Add your own production-only guard if you want one |
| Least-privilege keys | Server uses a restricted key limited to what it calls; the secret key is not used by jobs that only read | Dashboard, Developers, API keys; compare the key's permissions with the calls in the code | Accepts a restricted key; the Stripe calls it makes are creating customers, Checkout Sessions and Billing Portal sessions, and reading subscriptions (`src/billing/handlers`); verifying a webhook needs no API permission |
| No secret in the browser | Only the publishable key reaches the client; no secret in `NEXT_PUBLIC_` variables, repository or client bundle | Search the repository and its history, the built bundle and the hosting environment | No Stripe key in client code; the demo page only calls the API routes |
| Account hygiene | Two-factor authentication on every Dashboard user; owners know who can see live data and who can roll keys | Dashboard, Team | Not applicable (account setting) |

## 2. Checkout: how a customer starts paying

| Check | Sound looks like | How to look | This starter |
| --- | --- | --- | --- |
| The server decides the price | The client sends a plan key; the server maps it to a price id. No amount, price or customer id comes from the request | Read the checkout route | Implemented: `{"plan":"monthly"\|"yearly"}` is mapped to `STRIPE_PRICE_PRO_*` on the server |
| The customer comes from the signed-in user | One Stripe customer per app user, looked up from the session, created with an idempotency key, reused on later checkouts | The checkout and portal routes; the customer table | Implemented: the customer is stored per user, created with idempotency key `billing-customer-<userId>`, and reused |
| Who the subscription belongs to is recorded | `client_reference_id` and subscription metadata carry the app user id | A recent Checkout Session and subscription in the Dashboard | Implemented: `client_reference_id` and `subscription_data.metadata.user_id` |
| Returning from Checkout grants nothing | Access changes only from a verified webhook (or a server-side retrieve), never from the success URL | Where the success page reads state | Implemented: the success URL grants nothing |
| Double subscriptions are prevented | A second checkout for a user with a live subscription is refused or sent to the portal | Try it in test mode with the same user twice | Best effort: refused with `409` when our records or Stripe's list show a live subscription. Two Checkout Sessions opened before either is paid can both complete: not prevented |
| Retries do not create duplicate Sessions or customers | Idempotency keys on create calls that must not repeat | Search for `idempotencyKey` | Customer creation only. Session creation has no idempotency key; a retried request can create a second Session (harmless until both are paid) |
| Promotion codes, trials, coupons | Deliberate: if they exist, the entitlement code and the dunning rules account for them | Checkout Session parameters; the price and coupon list | Not implemented: no promotion codes or trial periods are set. Entitlement does treat `trialing` as `pro` if a trial comes from elsewhere |

## 3. Webhooks: where most money bugs live

| Check | Sound looks like | How to look | This starter |
| --- | --- | --- | --- |
| Signature verified on the **raw** body | The verification uses the exact bytes received, before any parsing or re-serialising | Read the webhook route | Implemented: raw bytes, `constructEvent`, `400` on a missing, wrong or tampered signature, and a stale timestamp (SDK default tolerance) |
| Body size bounded | The public endpoint refuses huge bodies before verifying | The route and the platform's limits | Implemented: 1 MiB cap, applied while streaming |
| Every event is applied once | The event id is recorded in the same transaction as the change, under a unique constraint; duplicates answer 200 | The webhook table schema and the handler; resend the same event in test mode | Implemented: `stripe_events` plus the state change in one transaction; concurrent deliveries are tested. The table has no retention job |
| Failures are retried, not swallowed | A processing error returns 5xx so Stripe retries; a deliberately ignored event returns 200 | Dashboard, Developers, Webhooks: failed deliveries and response codes | Implemented: `500 processing_failed` leaves the event unrecorded; unknown events and subscriptions that are not ours return 200 |
| Order does not matter | A late `updated` cannot undo a newer `deleted`; state carries a timestamp or the handler re-reads the object from Stripe | Look for any unconditional overwrite of status | Implemented: state is stamped with `event.created` (or the fetch time), older input is ignored, ties are resolved by asking Stripe; all six orders of three events are tested |
| The right events are subscribed | Exactly the events the code handles, on each endpoint, for each mode | Dashboard, the endpoint's event list, against the code's `switch` | Handles `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Everything else is acknowledged and ignored |
| Endpoint API version is known | The endpoint's API version matches the one the code was written for | Dashboard, the endpoint's details; the SDK version in the lockfile | The code reads `invoice.parent.subscription_details.subscription` and `items.data[].current_period_end`; create the endpoint on the API version of the pinned SDK (see the README) |
| Nothing depends on the endpoint being up | A reconciliation job can rebuild state from Stripe if deliveries were missed for longer than the retry window | Search for a job that lists subscriptions and compares | Not implemented: no reconciliation or backfill. Stripe retries failed deliveries for up to three days in live mode |
| Signing secret handling | Stored as a secret, one per endpoint, can be rolled; not in logs | Hosting environment, logs | Read from `STRIPE_WEBHOOK_SECRET`; not logged |

## 4. Failed payments, retries and dunning

| Check | Sound looks like | How to look | This starter |
| --- | --- | --- | --- |
| The retry schedule is chosen | Smart Retries or a custom schedule is configured, and the final action (cancel the subscription, mark it unpaid, leave it past due) is a decision | Dashboard, Billing settings for subscriptions and emails | Not implemented: that is Dashboard configuration; the code does not set it |
| Customers are told | Stripe's failed-payment emails or the app's own are on; there is a link to update the card | Dashboard email settings; a test failure in test mode with a failing test card | Not implemented: the starter sends no email. The portal link is available through `POST /api/portal` |
| Access during the retry period is a written rule | A grace period with a defined end, and what happens at the end | The entitlement code | Implemented: `past_due` keeps `pro` for `PAST_DUE_GRACE_DAYS` (default 7, `0` disables) from the moment it became past due; the clock does not restart on Stripe's retries; `unpaid`, `canceled`, `paused` and the `incomplete` statuses are `free` |
| Payment failures are recorded | The time and invoice of the last failure are kept for support | The subscription table | Implemented: `invoice.payment_failed` records the time and invoice id (`lastPaymentFailedAt`); it does not change entitlement by itself, the status change does |
| Extra authentication is handled | Payments that need customer action (SCA) have a path | Events subscribed and handled | Not implemented: `invoice.payment_action_required` is not handled |

## 5. Customer Portal

| Check | Sound looks like | How to look | This starter |
| --- | --- | --- | --- |
| The portal is configured on purpose | Cancellation (at period end or immediately), plan switching, payment-method updates, invoice history and tax ID editing are each an explicit choice, in test and live | Dashboard, Customer portal settings, both modes | Not configured by the code; it uses the account's default portal configuration. The README tells you to configure it, including the Tax ID toggle |
| The customer id comes from the session | The portal session is created for the signed-in user's stored customer, never for an id sent by the client | The portal route | Implemented: the customer is looked up from the user; `404 no_billing_account` if there is none |
| Changes made in the portal reach the app | `customer.subscription.updated` and `.deleted` update the app's state; cancellation at period end is visible | Cancel in the portal in test mode and watch the state | Implemented: status, price, period end and scheduled cancellation (`cancelAt`) are stored |

## 6. Tax

| Check | Sound looks like | How to look | This starter |
| --- | --- | --- | --- |
| Tax is switched on and configured | Stripe Tax is active, origin address and registrations are entered, products have tax codes, price tax behaviour is chosen | Dashboard, Tax settings and Registrations | Not verifiable from code. The README has a Stripe Tax setup checklist |
| Checkout collects what tax needs | Billing address required; business tax IDs collected if you sell to businesses | Checkout Session parameters | Implemented: `automatic_tax`, required billing address, `tax_id_collection`, and `customer_update` so the entered address and name are saved |
| Existing subscriptions are covered | Subscriptions created before tax was enabled have `automatic_tax` set | A list of subscriptions, with their tax setting | Not implemented: enabling Stripe Tax does not update existing subscriptions and the starter has no migration for them |
| A real invoice shows the tax | A test purchase in a registered location shows tax on the invoice and `total_details.amount_tax` | Test mode, Stripe's tax testing guide | Not tested automatically: the tests use a fake Stripe client and check the parameters sent |

## 7. Plan changes and proration

| Check | Sound looks like | How to look | This starter |
| --- | --- | --- | --- |
| Upgrades and downgrades have a defined effect | Each path states when the new price applies and whether the difference is charged or credited now or at renewal | Portal plan-switching settings; any code that updates a subscription | Not implemented: the starter never updates a subscription itself. Plan changes happen only if the Customer Portal is set up to allow them, and the starter stores the new price and period end when the update event arrives |
| Proration is deliberate | Server-side updates set `proration_behavior` (`create_prorations`, `none` or `always_invoice`) on purpose, not by default | Search for `subscriptions.update` | Not applicable: no such call |
| Entitlement follows the plan | A move between tiers changes what the user can do, and a stale tier cannot linger | The code that turns a subscription into access | Single `pro` plan: a price change does not change entitlement. Tiers would need a mapping from price id to plan |
| Monthly to yearly (and back) is tested | The first invoice and the renewal date are what the customer was told | Test mode with a test clock | Not tested |

## 8. Cancellation, refunds and disputes

| Check | Sound looks like | How to look | This starter |
| --- | --- | --- | --- |
| Cancellation semantics are explicit | At period end keeps access until the period ends; immediate cancellation removes it | A cancellation in test mode | Implemented for the first case: `cancelAt` is exposed, and access stays while the status is `active`; `customer.subscription.deleted` makes the plan `free` |
| Resubscribing works | A user with an old cancelled subscription can subscribe again without being blocked | A second checkout in test mode | Implemented: cancelled rows do not block checkout; a user is `pro` if any of their subscriptions is |
| Refunds and disputes have an owner | Someone watches them in the Dashboard, and access policy for a refunded or disputed payment is defined | Webhook endpoint events; the support process | Not implemented: `charge.refunded` and `charge.dispute.created` are not handled |

## 9. Data, entitlement and reconciliation

| Check | Sound looks like | How to look | This starter |
| --- | --- | --- | --- |
| One source of truth for access | A single function maps stored subscription state to what a user may do; no scattered `if (paid)` | Search for plan checks | Implemented: `src/domain/entitlement.ts`, a pure function with its own tests |
| The app's records can be compared with Stripe | Counts of active subscriptions agree between the database and the Dashboard; a scheduled check exists | Run the comparison once | Not implemented: there is no reconciliation job |
| Storage matches the deployment | The store survives restarts and works with more than one server instance | Where state lives | SQLite single-file store (single node) or an in-memory store that loses state on restart. For several instances, implement `BillingRepository` on Postgres |
| Logs are usable | Every webhook outcome and failure is logged with the event id and user id, without secrets or card data | Logs for one test purchase | Structured log lines with event id and type, outcome, stale-state events and failures |

## 10. How to write up the review

Group the findings so the owner can act on them:

- **Fix now**: money or access can go to the wrong party today (an unverified webhook, a client-chosen price, an access check that trusts the success page, a live key in a browser or in version control).
- **Fix soon**: wrong behaviour that costs revenue or support time (no idempotency, no failed-payment rule, no reconciliation, state that late events can overwrite).
- **Decide**: a business choice nobody has made (grace period length, what cancellation means, how upgrades are charged).
- **Unknown**: things that could not be checked read-only (live-mode Dashboard settings you could not see, behaviour that needs a real payment).

For each finding, write what was observed, where, the evidence (a file and line, a Dashboard screenshot, a test-mode replay), why it matters, and a suggested change. Say what was not reviewed.

## Replays to run in test mode

With this starter's sender (`npm run webhook:send`, see the README) or the Stripe CLI, against a copy of the setup under review:

1. The same event twice: the second must change nothing.
2. Two events for one subscription delivered in the opposite order: the final state must match the newer one.
3. An event with a broken signature and one with a stale timestamp: both refused.
4. A failed payment followed by recovery: access during the grace period and after it matches the written rule.
5. A cancellation at period end, then at once: access ends when the rule says it does.
6. A handler failure (stop the database): Stripe's retry must succeed afterwards, with no lost or doubled change.

## Limits

This is a checklist, not a certification. It does not cover Stripe Connect, usage-based billing, one-time payments, invoicing outside subscriptions, multiple currencies or legal and accounting questions. The Stripe behaviour described comes from Stripe's documentation as referenced in the README; check the current documentation before relying on it for a specific account.
