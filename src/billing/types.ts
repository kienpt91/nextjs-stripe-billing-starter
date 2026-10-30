/**
 * Billing records and the repository seam.
 *
 * All timestamps are unix seconds, the unit Stripe uses for `event.created`.
 */

/** Entitlement-relevant facts copied from a Stripe subscription object. */
export interface SubscriptionSnapshot {
  subscriptionId: string;
  customerId: string;
  /** Raw Stripe status. Unknown values are stored as-is and treated as "not entitled". */
  status: string;
  priceId: string | null;
  currentPeriodEnd: number | null;
  /** When the subscription is scheduled to end (unix seconds), or null if no cancellation is scheduled. */
  cancelAt: number | null;
}

export interface SubscriptionRecord extends SubscriptionSnapshot {
  userId: string;
  /**
   * The point in time the stored state is current as of: `event.created` for
   * state taken from a webhook payload, the time of the API call for state we
   * fetched ourselves. Older input never overwrites newer state.
   */
  stateAsOf: number;
  /** When the subscription entered `past_due`; null in every other status. */
  pastDueSince: number | null;
  lastPaymentFailedAt: number | null;
  lastFailedInvoiceId: string | null;
}

export interface WebhookEventMeta {
  id: string;
  type: string;
  created: number;
  receivedAt: number;
}

/**
 * Changes a webhook event wants to make. The webhook handler decides *what*
 * to change; the repository applies the list atomically together with the
 * "this event id has been processed" marker.
 */
export type Effect =
  | { kind: 'link_customer'; userId: string; customerId: string }
  | { kind: 'upsert_subscription'; userId: string; snapshot: SubscriptionSnapshot; asOf: number }
  | { kind: 'record_payment_failure'; subscriptionId: string; invoiceId: string; at: number };

export type CommitResult = { status: 'applied'; staleEffects: number } | { status: 'duplicate' };

export class CustomerLinkConflictError extends Error {
  constructor(
    readonly userId: string,
    readonly customerId: string,
  ) {
    super(`Stripe customer ${customerId} is already linked to a different user than ${userId}`);
    this.name = 'CustomerLinkConflictError';
  }
}

export interface BillingRepository {
  getStripeCustomerId(userId: string): Promise<string | null>;
  findUserIdByCustomerId(customerId: string): Promise<string | null>;
  /**
   * Links a user to a Stripe customer and returns the customer id now linked to
   * that user. The first link wins: if the user is already linked, the existing id
   * is returned and `customerId` is ignored. Throws CustomerLinkConflictError when
   * `customerId` belongs to another user.
   */
  linkCustomer(userId: string, customerId: string): Promise<string>;
  getSubscription(subscriptionId: string): Promise<SubscriptionRecord | null>;
  listSubscriptionsForUser(userId: string): Promise<SubscriptionRecord[]>;
  /** Fast-path check only. `commitEvent` is the authoritative duplicate guard. */
  hasProcessedEvent(eventId: string): Promise<boolean>;
  /**
   * Atomically records the event id and applies `effects`. If the event id was
   * already recorded nothing is applied and `{ status: 'duplicate' }` is returned.
   * If anything throws, neither the marker nor any effect is persisted, so a
   * redelivery of the event is processed from scratch.
   */
  commitEvent(event: WebhookEventMeta, effects: readonly Effect[]): Promise<CommitResult>;
}
