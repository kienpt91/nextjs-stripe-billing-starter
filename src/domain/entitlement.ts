/**
 * Pure mapping from Stripe subscription state to what the app lets a user do.
 * No Stripe SDK, no I/O, no clock: callers pass `now` (unix seconds).
 */

export const SECONDS_PER_DAY = 86_400;

/**
 * Subscription statuses Stripe documents. Stripe's SDK types the field as an
 * open string, so anything outside this list is treated as "not entitled".
 */
export const KNOWN_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'paused',
  'incomplete',
  'incomplete_expired',
  'canceled',
] as const;

export type KnownSubscriptionStatus = (typeof KNOWN_SUBSCRIPTION_STATUSES)[number];

export type Plan = 'free' | 'pro';

export type EntitlementReason =
  | 'active'
  | 'trialing'
  | 'past_due_in_grace'
  | 'past_due_grace_expired'
  | 'inactive_status'
  | 'no_subscription';

export interface EntitlementConfig {
  /** Days a `past_due` subscription keeps pro access, counted from when it became past due. */
  pastDueGraceDays: number;
}

/** The slice of a stored subscription that decides entitlement. */
export interface SubscriptionState {
  status: string;
  /** Unix seconds when the subscription entered `past_due`; null when it is not past due. */
  pastDueSince: number | null;
  /** Unix seconds this state is current as of. Used only to pick the freshest subscription. */
  stateAsOf: number;
}

export interface Entitlement {
  plan: Plan;
  reason: EntitlementReason;
  /** Unix seconds when pro access ends. Set only while a past-due grace period applies. */
  graceEndsAt: number | null;
}

const FREE_NO_SUBSCRIPTION: Entitlement = { plan: 'free', reason: 'no_subscription', graceEndsAt: null };

/**
 * `active` and `trialing` are pro. `past_due` is pro until the grace period ends
 * (the end instant itself is already free). Every other status, including
 * statuses this code has never heard of, is free: failing closed is the safe default.
 */
export function resolveEntitlement(
  subscription: Pick<SubscriptionState, 'status' | 'pastDueSince'>,
  now: number,
  config: EntitlementConfig,
): Entitlement {
  switch (subscription.status) {
    case 'active':
      return { plan: 'pro', reason: 'active', graceEndsAt: null };
    case 'trialing':
      return { plan: 'pro', reason: 'trialing', graceEndsAt: null };
    case 'past_due': {
      if (subscription.pastDueSince === null) {
        // A past_due subscription without a start time cannot be given a grace window.
        return { plan: 'free', reason: 'past_due_grace_expired', graceEndsAt: null };
      }
      const graceEndsAt = subscription.pastDueSince + assertGraceDays(config.pastDueGraceDays) * SECONDS_PER_DAY;
      return now < graceEndsAt
        ? { plan: 'pro', reason: 'past_due_in_grace', graceEndsAt }
        : { plan: 'free', reason: 'past_due_grace_expired', graceEndsAt };
    }
    default:
      return { plan: 'free', reason: 'inactive_status', graceEndsAt: null };
  }
}

/**
 * A user can have several subscription rows over time (cancel, then resubscribe).
 * Any pro subscription wins; otherwise the most recently updated one explains why the user is free.
 */
export function resolveUserEntitlement<T extends SubscriptionState>(
  subscriptions: readonly T[],
  now: number,
  config: EntitlementConfig,
): Entitlement & { subscription: T | null } {
  if (subscriptions.length === 0) return { ...FREE_NO_SUBSCRIPTION, subscription: null };

  const newestFirst = [...subscriptions].sort((a, b) => b.stateAsOf - a.stateAsOf);
  let fallback: (Entitlement & { subscription: T }) | null = null;
  for (const subscription of newestFirst) {
    const entitlement = resolveEntitlement(subscription, now, config);
    if (entitlement.plan === 'pro') return { ...entitlement, subscription };
    fallback ??= { ...entitlement, subscription };
  }
  // `subscriptions` is non-empty, so the loop assigned `fallback`.
  return fallback as Entitlement & { subscription: T };
}

/**
 * Statuses where the customer still has a subscription they should manage in the
 * Billing Portal instead of starting a second one through Checkout.
 */
export function isLiveSubscriptionStatus(status: string): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due' || status === 'unpaid' || status === 'paused';
}

function assertGraceDays(days: number): number {
  if (!Number.isFinite(days) || days < 0) {
    throw new RangeError(`pastDueGraceDays must be a non-negative number, got ${days}`);
  }
  return days;
}
