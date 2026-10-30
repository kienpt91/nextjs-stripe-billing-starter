import { CustomerLinkConflictError } from './types';
import type { Effect, SubscriptionRecord, SubscriptionSnapshot } from './types';

/** Minimal synchronous store both repository implementations expose to `applyEffects`. */
export interface EffectStore {
  getSubscription(subscriptionId: string): SubscriptionRecord | null;
  putSubscription(record: SubscriptionRecord): void;
  getCustomerIdForUser(userId: string): string | null;
  getUserIdForCustomer(customerId: string): string | null;
  insertCustomerLink(userId: string, customerId: string): void;
}

/**
 * Merges a subscription snapshot into the stored record. Returns null when the
 * snapshot is older than what is stored, so late deliveries cannot roll state back.
 * Equal timestamps are accepted: Stripe event timestamps have one-second
 * resolution, and the webhook handler resolves same-second ties by re-fetching.
 */
export function mergeSubscription(
  existing: SubscriptionRecord | null,
  userId: string,
  snapshot: SubscriptionSnapshot,
  asOf: number,
): SubscriptionRecord | null {
  if (existing !== null && asOf < existing.stateAsOf) return null;

  let pastDueSince: number | null = null;
  if (snapshot.status === 'past_due') {
    // Keep the original start while the subscription stays past due; the grace clock must not reset on every retry.
    pastDueSince = existing?.status === 'past_due' && existing.pastDueSince !== null ? existing.pastDueSince : asOf;
  }

  return {
    ...snapshot,
    userId: existing?.userId ?? userId,
    stateAsOf: asOf,
    pastDueSince,
    lastPaymentFailedAt: existing?.lastPaymentFailedAt ?? null,
    lastFailedInvoiceId: existing?.lastFailedInvoiceId ?? null,
  };
}

/** Records a payment failure, ignoring one that is older than the failure already stored. */
export function withPaymentFailure(existing: SubscriptionRecord, at: number, invoiceId: string): SubscriptionRecord {
  if (existing.lastPaymentFailedAt !== null && existing.lastPaymentFailedAt >= at) return existing;
  return { ...existing, lastPaymentFailedAt: at, lastFailedInvoiceId: invoiceId };
}

/** Shared effect semantics, so the in-memory and SQLite repositories cannot drift apart. */
export function applyEffects(store: EffectStore, effects: readonly Effect[]): { staleEffects: number } {
  let staleEffects = 0;
  for (const effect of effects) {
    switch (effect.kind) {
      case 'link_customer':
        linkCustomer(store, effect.userId, effect.customerId);
        break;
      case 'upsert_subscription': {
        const next = mergeSubscription(
          store.getSubscription(effect.snapshot.subscriptionId),
          effect.userId,
          effect.snapshot,
          effect.asOf,
        );
        if (next === null) staleEffects += 1;
        else store.putSubscription(next);
        break;
      }
      case 'record_payment_failure': {
        const existing = store.getSubscription(effect.subscriptionId);
        // A failure for a subscription we have not stored yet is dropped; the subscription event carries the status.
        if (existing !== null) store.putSubscription(withPaymentFailure(existing, effect.at, effect.invoiceId));
        break;
      }
    }
  }
  return { staleEffects };
}

/** First link wins; linking a customer that belongs to someone else is an integrity error. */
export function linkCustomer(store: EffectStore, userId: string, customerId: string): string {
  const existing = store.getCustomerIdForUser(userId);
  if (existing !== null) return existing;
  const owner = store.getUserIdForCustomer(customerId);
  if (owner !== null && owner !== userId) throw new CustomerLinkConflictError(userId, customerId);
  store.insertCustomerLink(userId, customerId);
  return customerId;
}
