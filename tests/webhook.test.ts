import { describe, expect, it } from 'vitest';
import { handleStripeWebhook } from '@/billing/handlers/webhook';
import { handleEntitlement } from '@/billing/handlers/entitlement';
import {
  DAY,
  T0,
  checkoutCompletedEvent,
  createContext,
  invoicePaymentFailedEvent,
  otherEvent,
  signedWebhookRequest,
  subscriptionEvent,
  subscriptionObject,
  userHeaders,
} from './helpers';
import type { TestContext } from './helpers';
import type Stripe from 'stripe';

async function deliver(ctx: TestContext, event: Stripe.Event | string, options?: Parameters<typeof signedWebhookRequest>[1]) {
  const response = await handleStripeWebhook(signedWebhookRequest(event, options), ctx.deps);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function entitlementOf(ctx: TestContext, userId = 'user_1') {
  const response = await handleEntitlement(
    new Request('http://localhost/api/entitlement', { headers: userHeaders(userId) }),
    ctx.deps,
  );
  return (await response.json()) as { plan: string; reason: string; graceEndsAt: number | null; lastPaymentFailedAt: number | null };
}

describe('webhook signature verification', () => {
  it('rejects a request without a stripe-signature header', async () => {
    const ctx = createContext();
    const request = new Request('http://localhost/api/stripe/webhook', { method: 'POST', body: '{}' });
    const response = await handleStripeWebhook(request, ctx.deps);
    expect(response.status).toBe(400);
  });

  it('rejects a payload signed with the wrong secret and processes nothing', async () => {
    const ctx = createContext();
    const event = subscriptionEvent('customer.subscription.updated', T0, subscriptionObject());

    const { status, body } = await deliver(ctx, event, { secret: 'whsec_someone_else' });

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_signature' });
    expect(await ctx.repo.hasProcessedEvent(event.id)).toBe(false);
    expect(await ctx.repo.getSubscription('sub_1')).toBeNull();
  });

  it('rejects a body that was modified after signing', async () => {
    const ctx = createContext();
    const event = subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ status: 'canceled' }));
    const original = signedWebhookRequest(event);
    const tampered = new Request(original.url, {
      method: 'POST',
      headers: original.headers,
      body: JSON.stringify(subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ status: 'active' }), event.id)),
    });

    const response = await handleStripeWebhook(tampered, ctx.deps);

    expect(response.status).toBe(400);
    expect(await ctx.repo.getSubscription('sub_1')).toBeNull();
  });

  it('rejects a correctly signed payload whose signature timestamp is outside the tolerance window', async () => {
    const ctx = createContext();
    const event = subscriptionEvent('customer.subscription.updated', T0, subscriptionObject());
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;

    const { status } = await deliver(ctx, event, { timestamp: tenMinutesAgo });

    expect(status).toBe(400);
    expect(await ctx.repo.hasProcessedEvent(event.id)).toBe(false);
  });

  it('rejects a signed body that is not JSON', async () => {
    const ctx = createContext();
    const { status } = await deliver(ctx, 'this is not json');
    expect(status).toBe(400);
  });
});

describe('idempotency', () => {
  it('processes a redelivered event only once', async () => {
    const ctx = createContext();
    ctx.fake.subscriptions.set('sub_1', subscriptionObject({ status: 'active' }));
    const event = checkoutCompletedEvent(T0);

    const first = await deliver(ctx, event);
    const second = await deliver(ctx, event);

    expect(first.body).toMatchObject({ received: true, outcome: 'processed' });
    expect(second).toEqual({ status: 200, body: { received: true, outcome: 'duplicate' } });
    // The duplicate never reached Stripe: the first delivery made the only API call.
    expect(ctx.fake.calls.subscriptionsRetrieve).toEqual(['sub_1']);
  });

  it('does not let a redelivery overwrite newer state that arrived in between', async () => {
    const ctx = createContext();
    const updated = subscriptionEvent('customer.subscription.updated', T0 + 10, subscriptionObject({ status: 'active' }));
    const deleted = subscriptionEvent('customer.subscription.deleted', T0 + 20, subscriptionObject({ status: 'canceled' }));

    await deliver(ctx, updated);
    await deliver(ctx, deleted);
    await deliver(ctx, updated);

    expect((await ctx.repo.getSubscription('sub_1'))?.status).toBe('canceled');
    expect((await entitlementOf(ctx)).plan).toBe('free');
  });

  it('applies a delivery that races with an identical one exactly once', async () => {
    const ctx = createContext();
    ctx.fake.subscriptions.set('sub_1', subscriptionObject({ status: 'active' }));
    const event = checkoutCompletedEvent(T0);

    const results = await Promise.all([deliver(ctx, event), deliver(ctx, event)]);

    expect(results.map((r) => r.body.outcome).sort()).toEqual(['duplicate', 'processed']);
    expect((await ctx.repo.listSubscriptionsForUser('user_1')).length).toBe(1);
  });

  it('does not mark an event processed when handling fails, so the retry succeeds', async () => {
    const ctx = createContext();
    ctx.fake.subscriptions.set('sub_1', subscriptionObject({ status: 'active' }));
    ctx.fake.failNext.retrieve = new Error('stripe is down');
    const event = checkoutCompletedEvent(T0);

    const failed = await deliver(ctx, event);
    expect(failed).toEqual({ status: 500, body: { error: 'processing_failed' } });
    expect(await ctx.repo.hasProcessedEvent(event.id)).toBe(false);
    expect(ctx.logs.some((log) => log.level === 'error' && log.message === 'webhook_processing_failed')).toBe(true);

    delete ctx.fake.failNext.retrieve;
    const retried = await deliver(ctx, event);
    expect(retried.body).toMatchObject({ outcome: 'processed' });
    expect((await entitlementOf(ctx)).plan).toBe('pro');
  });
});

describe('event ordering', () => {
  it('does not downgrade newer state when an older subscription event arrives late', async () => {
    const ctx = createContext();
    const newer = subscriptionEvent('customer.subscription.updated', T0 + 200, subscriptionObject({ status: 'past_due' }));
    const older = subscriptionEvent('customer.subscription.updated', T0 + 100, subscriptionObject({ status: 'active' }));

    await deliver(ctx, newer);
    const late = await deliver(ctx, older);

    expect(late.body).toEqual({ received: true, outcome: 'processed', staleEffects: 1 });
    const stored = await ctx.repo.getSubscription('sub_1');
    expect(stored?.status).toBe('past_due');
    expect(stored?.stateAsOf).toBe(T0 + 200);
    expect(ctx.logs.some((log) => log.message === 'webhook_stale_state_ignored')).toBe(true);
  });

  it('cannot be resurrected by a late "active" event after the subscription was deleted', async () => {
    const ctx = createContext();
    await deliver(ctx, subscriptionEvent('customer.subscription.deleted', T0 + 300, subscriptionObject({ status: 'canceled' })));
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0 + 250, subscriptionObject({ status: 'active' })));

    expect((await entitlementOf(ctx)).plan).toBe('free');
  });

  it('converges to the same final state for every delivery order', async () => {
    const make = () => [
      subscriptionEvent('customer.subscription.updated', T0 + 100, subscriptionObject({ status: 'active' }), 'evt_a'),
      subscriptionEvent('customer.subscription.updated', T0 + 200, subscriptionObject({ status: 'past_due' }), 'evt_b'),
      subscriptionEvent('customer.subscription.deleted', T0 + 300, subscriptionObject({ status: 'canceled' }), 'evt_c'),
    ];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ] as const;

    for (const order of orders) {
      const ctx = createContext();
      const events = make();
      for (const index of order) await deliver(ctx, events[index]!);
      const stored = await ctx.repo.getSubscription('sub_1');
      expect(stored?.status, `order ${order.join(',')}`).toBe('canceled');
      expect(stored?.stateAsOf, `order ${order.join(',')}`).toBe(T0 + 300);
    }
  });

  it('asks Stripe for the current state when two events share the same second', async () => {
    const ctx = createContext();
    const subscription = (status: string) => subscriptionObject({ status });
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0, subscription('past_due')));

    // Same `created` second as the stored state: the payload cannot tell us which is newer.
    // Stripe's answer ("active") wins over the payload ("past_due").
    ctx.fake.subscriptions.set('sub_1', subscription('active'));
    const tied = await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0, subscription('past_due')));

    expect(tied.body).toMatchObject({ outcome: 'processed' });
    expect(ctx.fake.calls.subscriptionsRetrieve).toEqual(['sub_1']);
    expect((await ctx.repo.getSubscription('sub_1'))?.status).toBe('active');
  });

  it('does not call Stripe for subscription events whose timestamps are strictly ordered', async () => {
    const ctx = createContext();
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ status: 'active' })));
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0 + 1, subscriptionObject({ status: 'past_due' })));
    expect(ctx.fake.calls.subscriptionsRetrieve).toEqual([]);
  });
});

describe('checkout.session.completed', () => {
  it('links the customer and stores the subscription Stripe reports', async () => {
    const ctx = createContext();
    ctx.fake.subscriptions.set('sub_1', subscriptionObject({ status: 'trialing', priceId: 'price_yearly_test', periodEnd: T0 + 14 * DAY }));

    const { body } = await deliver(ctx, checkoutCompletedEvent(T0));

    expect(body).toMatchObject({ outcome: 'processed' });
    expect(await ctx.repo.getStripeCustomerId('user_1')).toBe('cus_1');
    expect(await ctx.repo.getSubscription('sub_1')).toMatchObject({
      userId: 'user_1',
      customerId: 'cus_1',
      status: 'trialing',
      priceId: 'price_yearly_test',
      currentPeriodEnd: T0 + 14 * DAY,
    });
    expect((await entitlementOf(ctx)).reason).toBe('trialing');
  });

  it('is not fooled by an older subscription event arriving after the checkout was processed', async () => {
    const ctx = createContext();
    ctx.clock.now = T0 + 50;
    ctx.fake.subscriptions.set('sub_1', subscriptionObject({ status: 'active' }));
    await deliver(ctx, checkoutCompletedEvent(T0 + 10));

    // Created before the snapshot we fetched, so it describes older state.
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0 + 20, subscriptionObject({ status: 'incomplete' })));

    expect((await ctx.repo.getSubscription('sub_1'))?.status).toBe('active');
  });

  it('ignores one-time payment sessions without recording them', async () => {
    const ctx = createContext();
    const event = checkoutCompletedEvent(T0, { mode: 'payment', subscription: null });

    const { body } = await deliver(ctx, event);

    expect(body).toEqual({ received: true, outcome: 'ignored' });
    expect(await ctx.repo.hasProcessedEvent(event.id)).toBe(false);
    expect(ctx.fake.calls.subscriptionsRetrieve).toEqual([]);
  });

  it('ignores a session that has no client_reference_id', async () => {
    const ctx = createContext();
    const { body } = await deliver(ctx, checkoutCompletedEvent(T0, { userId: null }));
    expect(body).toEqual({ received: true, outcome: 'ignored' });
    expect(ctx.logs.some((log) => log.message === 'webhook_checkout_session_incomplete')).toBe(true);
  });
});

describe('customer.subscription.updated / deleted', () => {
  it('resolves the owner through the linked customer', async () => {
    const ctx = createContext();
    await ctx.repo.linkCustomer('user_9', 'cus_9');

    await deliver(
      ctx,
      subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ id: 'sub_9', customer: 'cus_9', userId: null })),
    );

    expect((await ctx.repo.getSubscription('sub_9'))?.userId).toBe('user_9');
  });

  it('falls back to the user id in subscription metadata when the customer is not linked yet', async () => {
    const ctx = createContext();

    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ userId: 'user_meta' })));

    expect((await ctx.repo.getSubscription('sub_1'))?.userId).toBe('user_meta');
  });

  it('acknowledges but does not record a subscription it cannot attribute to a user', async () => {
    const ctx = createContext();
    const event = subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ userId: null }));

    const { status, body } = await deliver(ctx, event);

    expect({ status, body }).toEqual({ status: 200, body: { received: true, outcome: 'ignored' } });
    expect(await ctx.repo.getSubscription('sub_1')).toBeNull();
    expect(await ctx.repo.hasProcessedEvent(event.id)).toBe(false);
  });

  it('turns pro off when the subscription is deleted, whatever status the payload carries', async () => {
    const ctx = createContext();
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ status: 'active' })));
    expect((await entitlementOf(ctx)).plan).toBe('pro');

    await deliver(ctx, subscriptionEvent('customer.subscription.deleted', T0 + 60, subscriptionObject({ status: 'active' })));

    expect((await ctx.repo.getSubscription('sub_1'))?.status).toBe('canceled');
    expect((await entitlementOf(ctx)).plan).toBe('free');
  });

  it('keeps pro through the grace period after a failed payment, then drops to free', async () => {
    const ctx = createContext();
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ status: 'active' })));
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0 + 100, subscriptionObject({ status: 'past_due' })));
    // Stripe retries payment and the subscription stays past_due; the grace clock must not restart.
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0 + 100 + DAY, subscriptionObject({ status: 'past_due' })));

    ctx.clock.now = T0 + 100 + 3 * DAY - 1;
    expect(await entitlementOf(ctx)).toMatchObject({ plan: 'pro', reason: 'past_due_in_grace', graceEndsAt: T0 + 100 + 3 * DAY });

    ctx.clock.now = T0 + 100 + 3 * DAY;
    expect(await entitlementOf(ctx)).toMatchObject({ plan: 'free', reason: 'past_due_grace_expired' });
  });

  it('restores pro when a past-due subscription is paid', async () => {
    const ctx = createContext();
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ status: 'past_due' })));
    ctx.clock.now = T0 + 5 * DAY;
    expect((await entitlementOf(ctx)).plan).toBe('free');

    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0 + 5 * DAY, subscriptionObject({ status: 'active' })));

    expect((await entitlementOf(ctx)).plan).toBe('pro');
  });
});

describe('invoice.payment_failed', () => {
  it('records the failure on the subscription', async () => {
    const ctx = createContext();
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ status: 'active' })));

    const { body } = await deliver(ctx, invoicePaymentFailedEvent(T0 + 500, { id: 'in_failed' }));

    expect(body).toMatchObject({ outcome: 'processed' });
    expect(await ctx.repo.getSubscription('sub_1')).toMatchObject({ lastPaymentFailedAt: T0 + 500, lastFailedInvoiceId: 'in_failed' });
    expect((await entitlementOf(ctx)).lastPaymentFailedAt).toBe(T0 + 500);
  });

  it('does not itself change entitlement; the subscription status does', async () => {
    const ctx = createContext();
    await deliver(ctx, subscriptionEvent('customer.subscription.updated', T0, subscriptionObject({ status: 'active' })));
    await deliver(ctx, invoicePaymentFailedEvent(T0 + 5));
    expect((await entitlementOf(ctx)).plan).toBe('pro');
  });

  it('ignores invoices that do not belong to a subscription', async () => {
    const ctx = createContext();
    const { body } = await deliver(ctx, invoicePaymentFailedEvent(T0, { subscription: null }));
    expect(body).toEqual({ received: true, outcome: 'ignored' });
  });
});

describe('other event types', () => {
  it('acknowledges events the app does not handle', async () => {
    const ctx = createContext();
    const event = otherEvent(T0);

    const { status, body } = await deliver(ctx, event);

    expect({ status, body }).toEqual({ status: 200, body: { received: true, outcome: 'ignored' } });
    expect(await ctx.repo.hasProcessedEvent(event.id)).toBe(false);
  });
});
