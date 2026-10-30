import { describe, expect, it } from 'vitest';
import {
  SECONDS_PER_DAY,
  isLiveSubscriptionStatus,
  resolveEntitlement,
  resolveUserEntitlement,
} from '@/domain/entitlement';

const config = { pastDueGraceDays: 3 };
const T0 = 1_800_000_000;

describe('resolveEntitlement', () => {
  it.each([
    ['active', 'active'],
    ['trialing', 'trialing'],
  ] as const)('%s is pro', (status, reason) => {
    expect(resolveEntitlement({ status, pastDueSince: null }, T0, config)).toEqual({
      plan: 'pro',
      reason,
      graceEndsAt: null,
    });
  });

  it.each(['canceled', 'unpaid', 'paused', 'incomplete', 'incomplete_expired', 'something_new_from_stripe'])(
    '%s is free',
    (status) => {
      const result = resolveEntitlement({ status, pastDueSince: null }, T0, config);
      expect(result.plan).toBe('free');
      expect(result.reason).toBe('inactive_status');
    },
  );

  describe('past_due grace period (3 days)', () => {
    const graceEnd = T0 + 3 * SECONDS_PER_DAY;
    const pastDue = { status: 'past_due', pastDueSince: T0 };

    it('is pro at the moment the subscription becomes past due', () => {
      expect(resolveEntitlement(pastDue, T0, config)).toEqual({
        plan: 'pro',
        reason: 'past_due_in_grace',
        graceEndsAt: graceEnd,
      });
    });

    it('is still pro one second before the grace period ends', () => {
      expect(resolveEntitlement(pastDue, graceEnd - 1, config).plan).toBe('pro');
    });

    it('is free exactly when the grace period ends (end is exclusive)', () => {
      expect(resolveEntitlement(pastDue, graceEnd, config)).toEqual({
        plan: 'free',
        reason: 'past_due_grace_expired',
        graceEndsAt: graceEnd,
      });
    });

    it('is free after the grace period', () => {
      expect(resolveEntitlement(pastDue, graceEnd + 1, config).plan).toBe('free');
    });

    it('with zero grace days is free immediately', () => {
      expect(resolveEntitlement(pastDue, T0, { pastDueGraceDays: 0 }).plan).toBe('free');
    });

    it('supports fractional grace days', () => {
      const halfDay = { pastDueGraceDays: 0.5 };
      expect(resolveEntitlement(pastDue, T0 + SECONDS_PER_DAY / 2 - 1, halfDay).plan).toBe('pro');
      expect(resolveEntitlement(pastDue, T0 + SECONDS_PER_DAY / 2, halfDay).plan).toBe('free');
    });

    it('fails closed when the past-due start time is unknown', () => {
      expect(resolveEntitlement({ status: 'past_due', pastDueSince: null }, T0, config)).toEqual({
        plan: 'free',
        reason: 'past_due_grace_expired',
        graceEndsAt: null,
      });
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid grace days (%s)', (days) => {
      expect(() => resolveEntitlement(pastDue, T0, { pastDueGraceDays: days })).toThrow(RangeError);
    });
  });
});

describe('resolveUserEntitlement', () => {
  const sub = (status: string, stateAsOf: number, pastDueSince: number | null = null) => ({
    id: `sub_${status}_${stateAsOf}`,
    status,
    stateAsOf,
    pastDueSince,
  });

  it('is free with no subscription', () => {
    expect(resolveUserEntitlement([], T0, config)).toEqual({
      plan: 'free',
      reason: 'no_subscription',
      graceEndsAt: null,
      subscription: null,
    });
  });

  it('prefers a pro subscription over a newer canceled one', () => {
    const result = resolveUserEntitlement([sub('active', T0), sub('canceled', T0 + 100)], T0 + 200, config);
    expect(result.plan).toBe('pro');
    expect(result.subscription?.status).toBe('active');
  });

  it('explains free using the most recently updated subscription', () => {
    const result = resolveUserEntitlement([sub('incomplete_expired', T0), sub('canceled', T0 + 100)], T0 + 200, config);
    expect(result.plan).toBe('free');
    expect(result.subscription?.status).toBe('canceled');
  });

  it('treats an expired past-due subscription as free even next to older history', () => {
    const pastDue = sub('past_due', T0 + 10, T0);
    const result = resolveUserEntitlement([sub('canceled', T0 - 1000), pastDue], T0 + 4 * SECONDS_PER_DAY, config);
    expect(result.plan).toBe('free');
    expect(result.reason).toBe('past_due_grace_expired');
  });
});

describe('isLiveSubscriptionStatus', () => {
  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused'])('%s is live', (status) => {
    expect(isLiveSubscriptionStatus(status)).toBe(true);
  });

  it.each(['canceled', 'incomplete', 'incomplete_expired', 'unknown'])('%s is not live', (status) => {
    expect(isLiveSubscriptionStatus(status)).toBe(false);
  });
});
