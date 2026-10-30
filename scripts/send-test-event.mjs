#!/usr/bin/env node
// Sends a correctly signed Stripe webhook event to a locally running app, so you can watch
// idempotency and ordering behave without a Stripe account or the Stripe CLI.
//
//   npm run webhook:send -- --status active --id evt_demo_1
//   npm run webhook:send -- --status past_due --created 1700000000
//
// The signing secret comes from --secret or STRIPE_WEBHOOK_SECRET (read from .env.local if present).
// Only events that need no Stripe API call are supported: subscription updated/deleted and
// invoice.payment_failed. checkout.session.completed makes the app fetch the subscription from
// Stripe, which needs a real checkout in test mode.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import Stripe from 'stripe';

try {
  process.loadEnvFile('.env.local');
} catch {
  // No .env.local: rely on the real environment.
}

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000/api/stripe/webhook' },
    type: { type: 'string', default: 'customer.subscription.updated' },
    status: { type: 'string', default: 'active' },
    created: { type: 'string' },
    id: { type: 'string' },
    user: { type: 'string', default: 'demo-user-1' },
    customer: { type: 'string', default: 'cus_local_demo' },
    subscription: { type: 'string', default: 'sub_local_demo' },
    secret: { type: 'string' },
  },
});

const secret = values.secret ?? process.env.STRIPE_WEBHOOK_SECRET;
if (!secret) {
  console.error('Set STRIPE_WEBHOOK_SECRET (for example in .env.local) or pass --secret.');
  process.exit(1);
}

const created = values.created ? Number(values.created) : Math.floor(Date.now() / 1000);
if (!Number.isInteger(created)) {
  console.error('--created must be a unix timestamp in seconds.');
  process.exit(1);
}

let object;
switch (values.type) {
  case 'customer.subscription.updated':
  case 'customer.subscription.deleted':
    object = {
      id: values.subscription,
      object: 'subscription',
      customer: values.customer,
      status: values.type.endsWith('deleted') ? 'canceled' : values.status,
      cancel_at: null,
      cancel_at_period_end: false,
      metadata: { user_id: values.user },
      items: {
        object: 'list',
        data: [{ id: 'si_local_demo', price: { id: 'price_local_demo' }, current_period_end: created + 30 * 86_400 }],
      },
    };
    break;
  case 'invoice.payment_failed':
    object = {
      id: `in_local_${randomUUID().slice(0, 8)}`,
      object: 'invoice',
      parent: { type: 'subscription_details', subscription_details: { subscription: values.subscription } },
    };
    break;
  default:
    console.error(`Unsupported --type ${values.type}`);
    process.exit(1);
}

const event = { id: values.id ?? `evt_local_${randomUUID()}`, object: 'event', type: values.type, created, data: { object } };
const payload = JSON.stringify(event);
// This client never calls Stripe; it is only used for its webhook signing helper.
const signer = new Stripe('sk_test_signing_only');
const header = signer.webhooks.generateTestHeaderString({ payload, secret });

const response = await fetch(values.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'stripe-signature': header },
  body: payload,
});
console.log(`${event.type} ${event.id} created=${created} -> ${response.status} ${await response.text()}`);
