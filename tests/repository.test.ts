import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryBillingRepository } from '@/billing/memory-repository';
import { SqliteBillingRepository } from '@/billing/sqlite-repository';
import { CustomerLinkConflictError } from '@/billing/types';
import type { BillingRepository, Effect, SubscriptionSnapshot, WebhookEventMeta } from '@/billing/types';

const T0 = 1_800_000_000;

function snapshot(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    subscriptionId: 'sub_1',
    customerId: 'cus_1',
    status: 'active',
    priceId: 'price_monthly',
    currentPeriodEnd: T0 + 30 * 86_400,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

let nextEvent = 0;
function eventMeta(created: number, overrides: Partial<WebhookEventMeta> = {}): WebhookEventMeta {
  nextEvent += 1;
  return { id: `evt_${nextEvent}`, type: 'customer.subscription.updated', created, receivedAt: created + 1, ...overrides };
}

function upsert(asOf: number, overrides: Partial<SubscriptionSnapshot> = {}, userId = 'user_1'): Effect {
  return { kind: 'upsert_subscription', userId, snapshot: snapshot(overrides), asOf };
}

const implementations: Array<[string, () => BillingRepository]> = [
  ['in-memory', () => new InMemoryBillingRepository()],
  ['sqlite', () => new SqliteBillingRepository(':memory:')],
];

describe.each(implementations)('BillingRepository contract: %s', (_name, create) => {
  it('links a user to a customer once and returns the first link on repeats', async () => {
    const repo = create();
    expect(await repo.getStripeCustomerId('user_1')).toBeNull();
    expect(await repo.linkCustomer('user_1', 'cus_1')).toBe('cus_1');
    expect(await repo.linkCustomer('user_1', 'cus_other')).toBe('cus_1');
    expect(await repo.getStripeCustomerId('user_1')).toBe('cus_1');
    expect(await repo.findUserIdByCustomerId('cus_1')).toBe('user_1');
    expect(await repo.findUserIdByCustomerId('cus_other')).toBeNull();
  });

  it('refuses to link a customer that belongs to another user', async () => {
    const repo = create();
    await repo.linkCustomer('user_1', 'cus_1');
    await expect(repo.linkCustomer('user_2', 'cus_1')).rejects.toBeInstanceOf(CustomerLinkConflictError);
    expect(await repo.getStripeCustomerId('user_2')).toBeNull();
  });

  it('applies a duplicate event id only once', async () => {
    const repo = create();
    const event = eventMeta(T0);
    expect(await repo.hasProcessedEvent(event.id)).toBe(false);

    expect(await repo.commitEvent(event, [upsert(T0)])).toEqual({ status: 'applied', staleEffects: 0 });
    expect(await repo.hasProcessedEvent(event.id)).toBe(true);

    // Same id, different effect: must not touch state.
    expect(await repo.commitEvent(event, [upsert(T0 + 5, { status: 'canceled' })])).toEqual({ status: 'duplicate' });
    expect((await repo.getSubscription('sub_1'))?.status).toBe('active');
  });

  it('ignores a subscription snapshot older than the stored one and counts it as stale', async () => {
    const repo = create();
    await repo.commitEvent(eventMeta(T0 + 10), [upsert(T0 + 10, { status: 'canceled' })]);

    const result = await repo.commitEvent(eventMeta(T0 + 5), [upsert(T0 + 5, { status: 'active' })]);

    expect(result).toEqual({ status: 'applied', staleEffects: 1 });
    const stored = await repo.getSubscription('sub_1');
    expect(stored?.status).toBe('canceled');
    expect(stored?.stateAsOf).toBe(T0 + 10);
  });

  it('accepts a snapshot with an equal timestamp', async () => {
    const repo = create();
    await repo.commitEvent(eventMeta(T0), [upsert(T0, { status: 'active' })]);
    await repo.commitEvent(eventMeta(T0), [upsert(T0, { status: 'past_due' })]);
    expect((await repo.getSubscription('sub_1'))?.status).toBe('past_due');
  });

  it('starts the past-due clock on entry and keeps it while the subscription stays past due', async () => {
    const repo = create();
    await repo.commitEvent(eventMeta(T0), [upsert(T0, { status: 'active' })]);
    await repo.commitEvent(eventMeta(T0 + 100), [upsert(T0 + 100, { status: 'past_due' })]);
    await repo.commitEvent(eventMeta(T0 + 500), [upsert(T0 + 500, { status: 'past_due' })]);

    expect((await repo.getSubscription('sub_1'))?.pastDueSince).toBe(T0 + 100);

    await repo.commitEvent(eventMeta(T0 + 900), [upsert(T0 + 900, { status: 'active' })]);
    expect((await repo.getSubscription('sub_1'))?.pastDueSince).toBeNull();

    await repo.commitEvent(eventMeta(T0 + 2000), [upsert(T0 + 2000, { status: 'past_due' })]);
    expect((await repo.getSubscription('sub_1'))?.pastDueSince).toBe(T0 + 2000);
  });

  it('keeps the original owner of a subscription when later events carry another user hint', async () => {
    const repo = create();
    await repo.commitEvent(eventMeta(T0), [upsert(T0, {}, 'user_1')]);
    await repo.commitEvent(eventMeta(T0 + 1), [upsert(T0 + 1, { status: 'past_due' }, 'user_2')]);
    expect((await repo.getSubscription('sub_1'))?.userId).toBe('user_1');
  });

  it('records payment failures, never moves them backwards, and ignores unknown subscriptions', async () => {
    const repo = create();
    await repo.commitEvent(eventMeta(T0), [upsert(T0)]);
    const failure = (at: number, invoiceId: string): Effect => ({
      kind: 'record_payment_failure',
      subscriptionId: 'sub_1',
      invoiceId,
      at,
    });

    await repo.commitEvent(eventMeta(T0 + 50), [failure(T0 + 50, 'in_new')]);
    await repo.commitEvent(eventMeta(T0 + 20), [failure(T0 + 20, 'in_old')]);
    await repo.commitEvent(eventMeta(T0 + 60), [
      { kind: 'record_payment_failure', subscriptionId: 'sub_unknown', invoiceId: 'in_x', at: T0 + 60 },
    ]);

    const stored = await repo.getSubscription('sub_1');
    expect(stored?.lastPaymentFailedAt).toBe(T0 + 50);
    expect(stored?.lastFailedInvoiceId).toBe('in_new');
    expect(await repo.getSubscription('sub_unknown')).toBeNull();
  });

  it('keeps payment-failure data across later subscription updates', async () => {
    const repo = create();
    await repo.commitEvent(eventMeta(T0), [upsert(T0)]);
    await repo.commitEvent(eventMeta(T0 + 5), [
      { kind: 'record_payment_failure', subscriptionId: 'sub_1', invoiceId: 'in_1', at: T0 + 5 },
    ]);
    await repo.commitEvent(eventMeta(T0 + 6), [upsert(T0 + 6, { status: 'past_due' })]);

    const stored = await repo.getSubscription('sub_1');
    expect(stored?.status).toBe('past_due');
    expect(stored?.lastFailedInvoiceId).toBe('in_1');
  });

  it('lists only the subscriptions that belong to the user', async () => {
    const repo = create();
    await repo.commitEvent(eventMeta(T0), [
      upsert(T0, { subscriptionId: 'sub_a', customerId: 'cus_a' }, 'user_a'),
      upsert(T0, { subscriptionId: 'sub_b', customerId: 'cus_b' }, 'user_b'),
      upsert(T0, { subscriptionId: 'sub_a2', customerId: 'cus_a' }, 'user_a'),
    ]);
    const ids = (await repo.listSubscriptionsForUser('user_a')).map((s) => s.subscriptionId).sort();
    expect(ids).toEqual(['sub_a', 'sub_a2']);
  });

  it('persists nothing from a failed commit, including the event marker', async () => {
    const repo = create();
    await repo.linkCustomer('user_1', 'cus_1');
    const event = eventMeta(T0);

    await expect(
      repo.commitEvent(event, [
        upsert(T0, { subscriptionId: 'sub_new' }),
        { kind: 'link_customer', userId: 'user_2', customerId: 'cus_1' },
      ]),
    ).rejects.toBeInstanceOf(CustomerLinkConflictError);

    expect(await repo.hasProcessedEvent(event.id)).toBe(false);
    expect(await repo.getSubscription('sub_new')).toBeNull();

    // The redelivery can still be processed once the problem is gone.
    expect(await repo.commitEvent(event, [upsert(T0, { subscriptionId: 'sub_new' })])).toEqual({
      status: 'applied',
      staleEffects: 0,
    });
  });
});

describe('SqliteBillingRepository', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'billing-'));
    dirs.push(dir);
    return join(dir, 'nested', 'billing.db');
  }

  it('creates the database file and keeps state across reopen', async () => {
    const path = tempDbPath();
    const first = new SqliteBillingRepository(path);
    const event = eventMeta(T0);
    await first.linkCustomer('user_1', 'cus_1');
    await first.commitEvent(event, [upsert(T0, { status: 'trialing' })]);
    first.close();

    const second = new SqliteBillingRepository(path);
    expect(await second.getStripeCustomerId('user_1')).toBe('cus_1');
    expect((await second.getSubscription('sub_1'))?.status).toBe('trialing');
    expect(await second.commitEvent(event, [upsert(T0 + 1, { status: 'canceled' })])).toEqual({ status: 'duplicate' });
    second.close();
  });

  it('rolls back the event marker and earlier effects when a statement fails mid-transaction', async () => {
    const path = tempDbPath();
    const repo = new SqliteBillingRepository(path);
    const event = eventMeta(T0);

    // Break the subscriptions table from a second connection so the second effect fails inside the transaction.
    const saboteur = new DatabaseSync(path);
    saboteur.exec('DROP TABLE billing_subscriptions');
    saboteur.close();

    await expect(
      repo.commitEvent(event, [{ kind: 'link_customer', userId: 'user_1', customerId: 'cus_1' }, upsert(T0)]),
    ).rejects.toThrow(/no such table/);

    expect(await repo.hasProcessedEvent(event.id)).toBe(false);
    expect(await repo.getStripeCustomerId('user_1')).toBeNull();
    repo.close();
  });
});
