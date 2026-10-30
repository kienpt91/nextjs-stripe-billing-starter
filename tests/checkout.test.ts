import { describe, expect, it } from 'vitest';
import { handleCheckout } from '@/billing/handlers/checkout';
import { handleEntitlement } from '@/billing/handlers/entitlement';
import { handlePortal } from '@/billing/handlers/portal';
import { T0, createContext, jsonRequest, userHeaders } from './helpers';
import type { TestContext } from './helpers';

const CHECKOUT_URL = 'http://localhost/api/checkout';
const PORTAL_URL = 'http://localhost/api/portal';

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('POST /api/checkout', () => {
  it('requires a signed-in user', async () => {
    const ctx = createContext();
    const response = await handleCheckout(jsonRequest(CHECKOUT_URL, { plan: 'monthly' }), ctx.deps);
    expect(response.status).toBe(401);
    expect(ctx.fake.calls.checkoutCreate).toEqual([]);
  });

  it.each([
    ['unknown plan', { plan: 'enterprise' }],
    ['missing plan', {}],
    ['plan of the wrong type', { plan: 5 }],
    ['null body', null],
    ['invalid JSON', '{not json'],
  ])('rejects %s with 400', async (_label, payload) => {
    const ctx = createContext();
    const response = await handleCheckout(jsonRequest(CHECKOUT_URL, payload, userHeaders('user_1')), ctx.deps);
    expect(response.status).toBe(400);
    expect(ctx.fake.calls.customersCreate).toEqual([]);
    expect(ctx.fake.calls.checkoutCreate).toEqual([]);
  });

  it('creates a subscription Checkout Session with Stripe Tax, billing address and tax ID collection', async () => {
    const ctx = createContext();

    const response = await handleCheckout(
      jsonRequest(CHECKOUT_URL, { plan: 'yearly' }, userHeaders('user_1', 'ada@example.com')),
      ctx.deps,
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ url: 'https://checkout.stripe.test/c/pay/cs_test_1' });
    expect(ctx.fake.calls.checkoutCreate).toHaveLength(1);
    expect(ctx.fake.calls.checkoutCreate[0]).toEqual({
      mode: 'subscription',
      customer: 'cus_fake_1',
      client_reference_id: 'user_1',
      line_items: [{ price: 'price_yearly_test', quantity: 1 }],
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
      subscription_data: { metadata: { user_id: 'user_1' } },
      success_url: 'https://app.example.com/?checkout=success',
      cancel_url: 'https://app.example.com/?checkout=cancelled',
    });
  });

  it('takes the price from server configuration, never from the request', async () => {
    const ctx = createContext();

    await handleCheckout(
      jsonRequest(CHECKOUT_URL, { plan: 'monthly', price: 'price_free_lunch', priceId: 'price_free_lunch' }, userHeaders('user_1')),
      ctx.deps,
    );

    expect(ctx.fake.calls.checkoutCreate[0]?.line_items).toEqual([{ price: 'price_monthly_test', quantity: 1 }]);
  });

  it('creates the Stripe customer once per user, with the user id in metadata and an idempotency key', async () => {
    const ctx = createContext();

    await handleCheckout(jsonRequest(CHECKOUT_URL, { plan: 'monthly' }, userHeaders('user_1', 'ada@example.com')), ctx.deps);

    expect(ctx.fake.calls.customersCreate).toEqual([
      {
        params: { metadata: { user_id: 'user_1' }, email: 'ada@example.com' },
        options: { idempotencyKey: 'billing-customer-user_1' },
      },
    ]);
    expect(await ctx.repo.getStripeCustomerId('user_1')).toBe('cus_fake_1');
  });

  it('reuses the stored customer on later checkouts and keeps customers separate per user', async () => {
    const ctx = createContext();
    const checkout = (userId: string) =>
      handleCheckout(jsonRequest(CHECKOUT_URL, { plan: 'monthly' }, userHeaders(userId)), ctx.deps);

    await checkout('user_1');
    await checkout('user_1');
    await checkout('user_2');

    expect(ctx.fake.calls.customersCreate).toHaveLength(2);
    expect(ctx.fake.calls.checkoutCreate.map((params) => params.customer)).toEqual(['cus_fake_1', 'cus_fake_1', 'cus_fake_2']);
  });

  it('omits the customer email when the signed-in user has none', async () => {
    const ctx = createContext();
    await handleCheckout(jsonRequest(CHECKOUT_URL, { plan: 'monthly' }, userHeaders('user_1')), ctx.deps);
    expect(ctx.fake.calls.customersCreate[0]?.params).toEqual({ metadata: { user_id: 'user_1' } });
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused'])(
    'refuses a second subscription while one is %s',
    async (status) => {
      const ctx = createContext();
      await ctx.repo.commitEvent({ id: 'evt_seed', type: 'seed', created: T0, receivedAt: T0 }, [
        {
          kind: 'upsert_subscription',
          userId: 'user_1',
          asOf: T0,
          snapshot: { subscriptionId: 'sub_1', customerId: 'cus_1', status, priceId: 'price_monthly_test', currentPeriodEnd: null, cancelAtPeriodEnd: false },
        },
      ]);

      const response = await handleCheckout(jsonRequest(CHECKOUT_URL, { plan: 'monthly' }, userHeaders('user_1')), ctx.deps);

      expect(response.status).toBe(409);
      expect((await body(response)).error).toBe('already_subscribed');
      expect(ctx.fake.calls.checkoutCreate).toEqual([]);
    },
  );

  it('lets a user with only a canceled subscription subscribe again, on the same customer', async () => {
    const ctx = createContext();
    await ctx.repo.linkCustomer('user_1', 'cus_1');
    await ctx.repo.commitEvent({ id: 'evt_seed', type: 'seed', created: T0, receivedAt: T0 }, [
      {
        kind: 'upsert_subscription',
        userId: 'user_1',
        asOf: T0,
        snapshot: { subscriptionId: 'sub_old', customerId: 'cus_1', status: 'canceled', priceId: null, currentPeriodEnd: null, cancelAtPeriodEnd: false },
      },
    ]);

    const response = await handleCheckout(jsonRequest(CHECKOUT_URL, { plan: 'monthly' }, userHeaders('user_1')), ctx.deps);

    expect(response.status).toBe(200);
    expect(ctx.fake.calls.customersCreate).toEqual([]);
    expect(ctx.fake.calls.checkoutCreate[0]?.customer).toBe('cus_1');
  });

  it('returns 502 without leaking Stripe error details, and logs them', async () => {
    const ctx = createContext();
    ctx.fake.failNext.checkout = new Error('No such price: price_monthly_test');

    const response = await handleCheckout(jsonRequest(CHECKOUT_URL, { plan: 'monthly' }, userHeaders('user_1')), ctx.deps);

    expect(response.status).toBe(502);
    expect(JSON.stringify(await body(response))).not.toContain('No such price');
    expect(ctx.logs).toContainEqual({
      level: 'error',
      message: 'checkout_failed',
      fields: { userId: 'user_1', error: 'No such price: price_monthly_test' },
    });
  });
});

describe('POST /api/portal', () => {
  it('requires a signed-in user', async () => {
    const ctx = createContext();
    const response = await handlePortal(jsonRequest(PORTAL_URL, {}), ctx.deps);
    expect(response.status).toBe(401);
  });

  it('returns 404 for a user who has never started checkout', async () => {
    const ctx = createContext();
    const response = await handlePortal(jsonRequest(PORTAL_URL, {}, userHeaders('user_1')), ctx.deps);
    expect(response.status).toBe(404);
    expect(ctx.fake.calls.portalCreate).toEqual([]);
  });

  it("opens a portal session for the user's own customer", async () => {
    const ctx = createContext();
    await ctx.repo.linkCustomer('user_1', 'cus_1');
    await ctx.repo.linkCustomer('user_2', 'cus_2');

    const response = await handlePortal(jsonRequest(PORTAL_URL, {}, userHeaders('user_2')), ctx.deps);

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ url: 'https://billing.stripe.test/p/session/test_1' });
    expect(ctx.fake.calls.portalCreate).toEqual([{ customer: 'cus_2', return_url: 'https://app.example.com/' }]);
  });

  it('returns 502 when Stripe refuses to create the portal session', async () => {
    const ctx = createContext();
    await ctx.repo.linkCustomer('user_1', 'cus_1');
    ctx.fake.failNext.portal = new Error('No configuration provided');

    const response = await handlePortal(jsonRequest(PORTAL_URL, {}, userHeaders('user_1')), ctx.deps);

    expect(response.status).toBe(502);
    expect(JSON.stringify(await body(response))).not.toContain('No configuration');
  });
});

describe('GET /api/entitlement', () => {
  const get = (ctx: TestContext, headers: Record<string, string> = {}) =>
    handleEntitlement(new Request('http://localhost/api/entitlement', { headers }), ctx.deps);

  it('requires a signed-in user', async () => {
    expect((await get(createContext())).status).toBe(401);
  });

  it('reports free for a user with no subscription', async () => {
    const response = await get(createContext(), userHeaders('user_1'));
    expect(await body(response)).toEqual({
      plan: 'free',
      reason: 'no_subscription',
      graceEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      lastPaymentFailedAt: null,
    });
  });

  it("does not expose another user's subscription", async () => {
    const ctx = createContext();
    await ctx.repo.commitEvent({ id: 'evt_seed', type: 'seed', created: T0, receivedAt: T0 }, [
      {
        kind: 'upsert_subscription',
        userId: 'user_1',
        asOf: T0,
        snapshot: { subscriptionId: 'sub_1', customerId: 'cus_1', status: 'active', priceId: null, currentPeriodEnd: T0 + 100, cancelAtPeriodEnd: true },
      },
    ]);

    expect(await body(await get(ctx, userHeaders('user_1')))).toMatchObject({ plan: 'pro', cancelAtPeriodEnd: true, currentPeriodEnd: T0 + 100 });
    expect(await body(await get(ctx, userHeaders('user_2')))).toMatchObject({ plan: 'free', reason: 'no_subscription' });
  });
});
