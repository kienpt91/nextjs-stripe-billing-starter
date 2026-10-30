import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as checkoutRoute } from '@/app/api/checkout/route';
import { GET as entitlementRoute } from '@/app/api/entitlement/route';
import { POST as portalRoute } from '@/app/api/portal/route';
import { POST as webhookRoute } from '@/app/api/stripe/webhook/route';
import { SqliteBillingRepository } from '@/billing/sqlite-repository';
import { setDepsForTesting } from '@/lib/container';
import {
  T0,
  checkoutCompletedEvent,
  createContext,
  jsonRequest,
  signedWebhookRequest,
  subscriptionEvent,
  subscriptionObject,
  userHeaders,
} from './helpers';
import type { TestContext } from './helpers';

describe('route modules, wired to a SQLite store', () => {
  let dir: string;
  let repo: SqliteBillingRepository;
  let ctx: TestContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'billing-routes-'));
    repo = new SqliteBillingRepository(join(dir, 'billing.db'));
    ctx = createContext({ repo });
    setDepsForTesting(ctx.deps);
  });

  afterEach(() => {
    setDepsForTesting(undefined);
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const entitlement = async (userId: string) =>
    (await entitlementRoute(new Request('http://localhost/api/entitlement', { headers: userHeaders(userId) }))).json() as Promise<{
      plan: string;
      reason: string;
    }>;

  it('walks the whole path: checkout, webhook activation, portal, cancellation', async () => {
    expect(await entitlement('user_1')).toMatchObject({ plan: 'free', reason: 'no_subscription' });

    // 1. The user starts checkout; a Stripe customer is created and stored.
    const checkout = await checkoutRoute(jsonRequest('http://localhost/api/checkout', { plan: 'monthly' }, userHeaders('user_1', 'ada@example.com')));
    expect(checkout.status).toBe(200);
    const customerId = await repo.getStripeCustomerId('user_1');
    expect(customerId).toBe('cus_fake_1');

    // 2. Entitlement is still free: finishing Checkout in the browser grants nothing by itself.
    expect(await entitlement('user_1')).toMatchObject({ plan: 'free' });

    // 3. Stripe's signed webhook is what activates the subscription.
    ctx.fake.subscriptions.set('sub_1', subscriptionObject({ customer: customerId!, status: 'active' }));
    const completed = await webhookRoute(signedWebhookRequest(checkoutCompletedEvent(T0, { customer: customerId! })));
    expect(completed.status).toBe(200);
    expect(await entitlement('user_1')).toMatchObject({ plan: 'pro', reason: 'active' });

    // 4. A second checkout is refused; the portal is the way to change a live subscription.
    const again = await checkoutRoute(jsonRequest('http://localhost/api/checkout', { plan: 'yearly' }, userHeaders('user_1')));
    expect(again.status).toBe(409);
    const portal = await portalRoute(jsonRequest('http://localhost/api/portal', {}, userHeaders('user_1')));
    expect(portal.status).toBe(200);

    // 5. Cancellation arrives as a signed webhook.
    const deleted = await webhookRoute(
      signedWebhookRequest(subscriptionEvent('customer.subscription.deleted', T0 + 1000, subscriptionObject({ customer: customerId!, status: 'canceled' }))),
    );
    expect(deleted.status).toBe(200);
    expect(await entitlement('user_1')).toMatchObject({ plan: 'free', reason: 'inactive_status' });
  });

  it('rejects unsigned webhook calls at the route level', async () => {
    const response = await webhookRoute(new Request('http://localhost/api/stripe/webhook', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(400);
  });

  it('keeps users isolated: one user cannot open the portal for, or inherit, another user\'s subscription', async () => {
    await webhookRoute(signedWebhookRequest(subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ userId: 'user_1' }))));

    expect(await entitlement('user_1')).toMatchObject({ plan: 'pro' });
    expect(await entitlement('user_2')).toMatchObject({ plan: 'free' });
    const portal = await portalRoute(jsonRequest('http://localhost/api/portal', {}, userHeaders('user_2')));
    expect(portal.status).toBe(404);
  });
});

describe('route modules without configuration', () => {
  afterEach(() => {
    setDepsForTesting(undefined);
    vi.restoreAllMocks();
  });

  it('answers 500 billing_not_configured instead of crashing when env vars are missing', async () => {
    setDepsForTesting(undefined);
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await webhookRoute(new Request('http://localhost/api/stripe/webhook', { method: 'POST', body: '{}' }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'billing_not_configured' });
    expect(logged).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });
});
