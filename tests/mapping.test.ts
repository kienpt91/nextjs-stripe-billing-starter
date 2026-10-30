import { describe, expect, it } from 'vitest';
import { idOf, snapshotOf } from '@/billing/stripe-mapping';
import { DAY, T0, subscriptionObject } from './helpers';

describe('idOf', () => {
  it('accepts an id string, an expanded object, or nothing', () => {
    expect(idOf('cus_1')).toBe('cus_1');
    expect(idOf({ id: 'cus_2' })).toBe('cus_2');
    expect(idOf(null)).toBeNull();
    expect(idOf(undefined)).toBeNull();
  });
});

describe('snapshotOf', () => {
  it('copies the fields entitlement depends on', () => {
    expect(snapshotOf(subscriptionObject({ status: 'trialing', priceId: 'price_y', periodEnd: T0 + 7 * DAY }))).toEqual({
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      status: 'trialing',
      priceId: 'price_y',
      currentPeriodEnd: T0 + 7 * DAY,
      cancelAt: null,
    });
  });

  it('reads the customer id from an expanded customer object', () => {
    const subscription = { ...subscriptionObject(), customer: { id: 'cus_expanded' } } as unknown as Parameters<typeof snapshotOf>[0];
    expect(snapshotOf(subscription).customerId).toBe('cus_expanded');
  });

  it('reports a scheduled cancellation set with cancel_at_period_end as the period end', () => {
    expect(snapshotOf(subscriptionObject({ cancelAtPeriodEnd: true, periodEnd: T0 + DAY })).cancelAt).toBe(T0 + DAY);
  });

  it('reports a scheduled cancellation set with cancel_at as that date', () => {
    expect(snapshotOf(subscriptionObject({ cancelAt: T0 + 3 * DAY, periodEnd: T0 + DAY })).cancelAt).toBe(T0 + 3 * DAY);
  });

  it('uses the latest period end across subscription items', () => {
    const subscription = subscriptionObject();
    subscription.items.data.push({ id: 'si_2', price: { id: 'price_addon' }, current_period_end: T0 + 90 * DAY } as never);
    expect(snapshotOf(subscription).currentPeriodEnd).toBe(T0 + 90 * DAY);
  });

  it('handles a subscription without items', () => {
    const subscription = subscriptionObject({ cancelAtPeriodEnd: true });
    subscription.items.data.length = 0;
    expect(snapshotOf(subscription)).toMatchObject({ priceId: null, currentPeriodEnd: null, cancelAt: null });
  });

  it('keeps statuses this code does not know about', () => {
    expect(snapshotOf(subscriptionObject({ status: 'brand_new_status' })).status).toBe('brand_new_status');
  });
});
