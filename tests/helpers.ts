import Stripe from 'stripe';
import type { BillingDeps, BillingStripe, Logger } from '@/billing/deps';
import { InMemoryBillingRepository } from '@/billing/memory-repository';
import type { BillingRepository, SubscriptionSnapshot } from '@/billing/types';
import { demoHeaderAuth } from '@/lib/auth';
import type { BillingConfig } from '@/lib/config';

export const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests';
export const T0 = 1_800_000_000;
export const DAY = 86_400;

/**
 * A real Stripe client that is never used for API calls (there is no network in tests).
 * Only its `webhooks` helper is used, for real signature generation and verification.
 */
export const signingStripe = new Stripe('sk_test_signing_only');

export interface FakeStripeCalls {
  customersCreate: Array<{ params: Stripe.CustomerCreateParams; options: Stripe.RequestOptions | undefined }>;
  checkoutCreate: Stripe.Checkout.SessionCreateParams[];
  portalCreate: Stripe.BillingPortal.SessionCreateParams[];
  subscriptionsRetrieve: string[];
  subscriptionsList: Stripe.SubscriptionListParams[];
}

export interface FakeStripe {
  stripe: BillingStripe;
  calls: FakeStripeCalls;
  /**
   * Stripe's view of the world. `subscriptions.retrieve` answers from it by id, and `subscriptions.list`
   * lists the ones for a customer that are not canceled, which is Stripe's default when no status is given.
   */
  subscriptions: Map<string, Stripe.Subscription>;
  failNext: { checkout?: Error; portal?: Error; retrieve?: Error; list?: Error };
}

export function createFakeStripe(): FakeStripe {
  const calls: FakeStripeCalls = {
    customersCreate: [],
    checkoutCreate: [],
    portalCreate: [],
    subscriptionsRetrieve: [],
    subscriptionsList: [],
  };
  const subscriptions = new Map<string, Stripe.Subscription>();
  const failNext: FakeStripe['failNext'] = {};
  let customerCounter = 0;

  const stripe: BillingStripe = {
    customers: {
      async create(params, options) {
        calls.customersCreate.push({ params, options });
        customerCounter += 1;
        return { id: `cus_fake_${customerCounter}` };
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          calls.checkoutCreate.push(params);
          if (failNext.checkout) throw failNext.checkout;
          return { id: 'cs_test_1', url: 'https://checkout.stripe.test/c/pay/cs_test_1' };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          calls.portalCreate.push(params);
          if (failNext.portal) throw failNext.portal;
          return { url: 'https://billing.stripe.test/p/session/test_1' };
        },
      },
    },
    subscriptions: {
      async retrieve(id) {
        calls.subscriptionsRetrieve.push(id);
        if (failNext.retrieve) throw failNext.retrieve;
        const subscription = subscriptions.get(id);
        if (!subscription) throw new Error(`No such subscription: '${id}'`);
        return subscription;
      },
      async *list(params) {
        calls.subscriptionsList.push(params);
        if (failNext.list) throw failNext.list;
        for (const subscription of subscriptions.values()) {
          if (subscription.customer === params.customer && subscription.status !== 'canceled') yield subscription;
        }
      },
    },
    webhooks: signingStripe.webhooks,
  };

  return { stripe, calls, subscriptions, failNext };
}

export interface TestContext {
  deps: BillingDeps;
  fake: FakeStripe;
  repo: BillingRepository;
  clock: { now: number };
  logs: Array<{ level: 'info' | 'warn' | 'error'; message: string; fields?: Record<string, unknown> }>;
}

export const testConfig: BillingConfig = {
  appUrl: 'https://app.example.com',
  webhookSecret: WEBHOOK_SECRET,
  plans: { monthly: 'price_monthly_test', yearly: 'price_yearly_test' },
  pastDueGraceDays: 3,
};

export function createContext(options: { repo?: BillingRepository } = {}): TestContext {
  const fake = createFakeStripe();
  const repo = options.repo ?? new InMemoryBillingRepository();
  const clock = { now: T0 };
  const logs: TestContext['logs'] = [];
  const record =
    (level: 'info' | 'warn' | 'error'): Logger['info'] =>
    (message, fields) => {
      logs.push(fields ? { level, message, fields } : { level, message });
    };

  const deps: BillingDeps = {
    stripe: fake.stripe,
    repo,
    auth: demoHeaderAuth,
    config: testConfig,
    clock: () => clock.now,
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
  };
  return { deps, fake, repo, clock, logs };
}

export function userHeaders(userId: string, email?: string): Record<string, string> {
  const headers: Record<string, string> = { 'x-demo-user-id': userId };
  if (email) headers['x-demo-user-email'] = email;
  return headers;
}

export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// ---------- Stripe object builders (only the fields this app reads) ----------

export interface SubscriptionOptions {
  id?: string;
  customer?: string;
  status?: string;
  userId?: string | null;
  priceId?: string;
  periodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  cancelAt?: number | null;
}

export function subscriptionObject(options: SubscriptionOptions = {}): Stripe.Subscription {
  const { id = 'sub_1', customer = 'cus_1', status = 'active', userId = 'user_1', priceId = 'price_monthly_test' } = options;
  return {
    id,
    object: 'subscription',
    customer,
    status,
    cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    cancel_at: options.cancelAt ?? null,
    metadata: userId === null ? {} : { user_id: userId },
    items: {
      object: 'list',
      data: [{ id: 'si_1', price: { id: priceId }, current_period_end: options.periodEnd ?? T0 + 30 * DAY }],
    },
  } as unknown as Stripe.Subscription;
}

/** Stores a subscription directly, bypassing webhooks, for tests that start from existing state. */
export async function seedSubscription(
  repo: BillingRepository,
  overrides: Partial<SubscriptionSnapshot> & { userId?: string } = {},
): Promise<void> {
  const { userId = 'user_1', ...snapshot } = overrides;
  await repo.commitEvent({ id: `evt_seed_${userId}_${snapshot.subscriptionId ?? 'sub_1'}`, type: 'seed', created: T0, receivedAt: T0 }, [
    {
      kind: 'upsert_subscription',
      userId,
      asOf: T0,
      snapshot: {
        subscriptionId: 'sub_1',
        customerId: 'cus_1',
        status: 'active',
        priceId: 'price_monthly_test',
        currentPeriodEnd: null,
        cancelAt: null,
        ...snapshot,
      },
    },
  ]);
}

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `evt_test_${eventCounter}`;
}

export function subscriptionEvent(
  type: 'customer.subscription.updated' | 'customer.subscription.deleted',
  created: number,
  subscription: Stripe.Subscription,
  id = nextEventId(),
): Stripe.Event {
  return { id, object: 'event', type, created, data: { object: subscription } } as unknown as Stripe.Event;
}

export function checkoutCompletedEvent(
  created: number,
  session: { userId?: string | null; customer?: string; subscription?: string | null; mode?: string } = {},
  id = nextEventId(),
): Stripe.Event {
  const { userId = 'user_1', customer = 'cus_1', subscription = 'sub_1', mode = 'subscription' } = session;
  return {
    id,
    object: 'event',
    type: 'checkout.session.completed',
    created,
    data: {
      object: { id: 'cs_test_1', object: 'checkout.session', mode, client_reference_id: userId, customer, subscription },
    },
  } as unknown as Stripe.Event;
}

export function invoicePaymentFailedEvent(
  created: number,
  invoice: { id?: string; subscription?: string | null } = {},
  id = nextEventId(),
): Stripe.Event {
  const { id: invoiceId = 'in_1', subscription = 'sub_1' } = invoice;
  return {
    id,
    object: 'event',
    type: 'invoice.payment_failed',
    created,
    data: {
      object: {
        id: invoiceId,
        object: 'invoice',
        parent: subscription ? { type: 'subscription_details', subscription_details: { subscription } } : null,
      },
    },
  } as unknown as Stripe.Event;
}

export function otherEvent(created: number, type = 'customer.created', id = nextEventId()): Stripe.Event {
  return { id, object: 'event', type, created, data: { object: { id: 'cus_1', object: 'customer' } } } as unknown as Stripe.Event;
}

// ---------- Webhook requests ----------

export interface SignOptions {
  secret?: string;
  /** Signature timestamp in unix seconds. Defaults to now. */
  timestamp?: number;
}

export function signedWebhookRequest(event: Stripe.Event | string, options: SignOptions = {}): Request {
  const payload = typeof event === 'string' ? event : JSON.stringify(event);
  const signOptions: Parameters<typeof signingStripe.webhooks.generateTestHeaderString>[0] = {
    payload,
    secret: options.secret ?? WEBHOOK_SECRET,
  };
  if (options.timestamp !== undefined) signOptions.timestamp = options.timestamp;
  const header = signingStripe.webhooks.generateTestHeaderString(signOptions);
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
}
