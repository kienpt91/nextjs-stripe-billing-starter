import type Stripe from 'stripe';
import type { SubscriptionSnapshot } from './types';

/** Stripe fields are either an id string or the expanded object; we only ever need the id. */
export function idOf(reference: string | { id: string } | null | undefined): string | null {
  if (reference === null || reference === undefined) return null;
  return typeof reference === 'string' ? reference : reference.id;
}

export function snapshotOf(subscription: Stripe.Subscription): SubscriptionSnapshot {
  const items = subscription.items.data;
  // The billing period lives on subscription items in current API versions.
  const currentPeriodEnd = items.length > 0 ? Math.max(...items.map((item) => item.current_period_end)) : null;
  return {
    subscriptionId: subscription.id,
    customerId: idOf(subscription.customer) ?? '',
    status: subscription.status,
    priceId: items[0]?.price.id ?? null,
    currentPeriodEnd,
    // Stripe expresses a scheduled cancellation either as `cancel_at` (a date) or as `cancel_at_period_end`.
    cancelAt: subscription.cancel_at ?? (subscription.cancel_at_period_end ? currentPeriodEnd : null),
  };
}
