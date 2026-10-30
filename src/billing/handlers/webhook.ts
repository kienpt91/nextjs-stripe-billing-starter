import type Stripe from 'stripe';
import { errorMessage } from '@/lib/errors';
import { json } from '@/lib/http';
import type { BillingDeps } from '../deps';
import { idOf, snapshotOf } from '../stripe-mapping';
import type { Effect } from '../types';

/**
 * POST /api/stripe/webhook
 *
 * 400  signature missing or invalid (nothing is read from the body)
 * 200  handled, duplicate, or an event type/shape we deliberately ignore
 * 500  our processing failed; nothing was persisted, so Stripe's retry starts clean
 */
export async function handleStripeWebhook(request: Request, deps: BillingDeps): Promise<Response> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return json(400, { error: 'missing_signature' });

  // Verification needs the exact bytes Stripe signed, so read the body as text and never re-serialize it.
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(payload, signature, deps.config.webhookSecret);
  } catch (error) {
    deps.logger.warn('webhook_signature_rejected', { error: errorMessage(error) });
    return json(400, { error: 'invalid_signature' });
  }

  try {
    // Cheap early exit for redeliveries. The authoritative guard is the atomic claim inside commitEvent.
    if (await deps.repo.hasProcessedEvent(event.id)) {
      return json(200, { received: true, outcome: 'duplicate' });
    }

    const effects = await planEffects(event, deps);
    if (effects === null) return json(200, { received: true, outcome: 'ignored' });

    const result = await deps.repo.commitEvent(
      { id: event.id, type: event.type, created: event.created, receivedAt: deps.clock() },
      effects,
    );
    if (result.status === 'duplicate') return json(200, { received: true, outcome: 'duplicate' });

    if (result.staleEffects > 0) {
      deps.logger.info('webhook_stale_state_ignored', { eventId: event.id, type: event.type, created: event.created });
    }
    return json(200, { received: true, outcome: 'processed', staleEffects: result.staleEffects });
  } catch (error) {
    deps.logger.error('webhook_processing_failed', { eventId: event.id, type: event.type, error: errorMessage(error) });
    return json(500, { error: 'processing_failed' });
  }
}

/**
 * Turns an event into the changes it implies. Returns null for events that need no
 * action and should not be recorded as processed.
 */
async function planEffects(event: Stripe.Event, deps: BillingDeps): Promise<Effect[] | null> {
  switch (event.type) {
    case 'checkout.session.completed':
      return planCheckoutCompleted(event.data.object, event.created, deps);
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return planSubscriptionChange(event, deps);
    case 'invoice.payment_failed':
      return planPaymentFailed(event.data.object, event.created);
    default:
      return null;
  }
}

async function planCheckoutCompleted(
  session: Stripe.Checkout.Session,
  eventCreated: number,
  deps: BillingDeps,
): Promise<Effect[] | null> {
  if (session.mode !== 'subscription') return null;

  const userId = session.client_reference_id;
  const customerId = idOf(session.customer);
  const subscriptionId = idOf(session.subscription);
  if (!userId || !customerId || !subscriptionId) {
    deps.logger.warn('webhook_checkout_session_incomplete', { sessionId: session.id });
    return null;
  }

  // The payload does not carry the subscription's status, so ask Stripe. That answer is newer than
  // the event itself, hence the fetch time (not event.created) is what the snapshot is stamped with.
  const asOf = Math.max(deps.clock(), eventCreated);
  const subscription = await deps.stripe.subscriptions.retrieve(subscriptionId);

  return [
    { kind: 'link_customer', userId, customerId },
    { kind: 'upsert_subscription', userId, snapshot: snapshotOf(subscription), asOf },
  ];
}

async function planSubscriptionChange(
  event: Extract<Stripe.Event, { type: 'customer.subscription.updated' | 'customer.subscription.deleted' }>,
  deps: BillingDeps,
): Promise<Effect[] | null> {
  const payloadSubscription = event.data.object;
  const customerId = idOf(payloadSubscription.customer);
  const userId =
    (customerId ? await deps.repo.findUserIdByCustomerId(customerId) : null) ??
    payloadSubscription.metadata?.user_id ??
    null;
  if (!userId) {
    // Not one of ours (for example another product on the same Stripe account), or created without our metadata.
    deps.logger.warn('webhook_subscription_owner_unknown', { subscriptionId: payloadSubscription.id, eventId: event.id });
    return null;
  }

  let subscription = payloadSubscription;
  let asOf = event.created;

  // Stripe timestamps events in whole seconds, so two events can share a `created` value and the
  // timestamp cannot say which came last. When this event ties with the stored state, stop
  // guessing and ask Stripe for the current subscription instead.
  const stored = await deps.repo.getSubscription(payloadSubscription.id);
  if (stored !== null && stored.stateAsOf === event.created) {
    asOf = Math.max(deps.clock(), event.created);
    subscription = await deps.stripe.subscriptions.retrieve(payloadSubscription.id);
  }

  const snapshot = snapshotOf(subscription);
  // `customer.subscription.deleted` means the subscription ended, whatever the payload's status field says.
  if (event.type === 'customer.subscription.deleted') snapshot.status = 'canceled';

  return [{ kind: 'upsert_subscription', userId, snapshot, asOf }];
}

function planPaymentFailed(invoice: Stripe.Invoice, eventCreated: number): Effect[] | null {
  const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
  if (!subscriptionId) return null; // one-off invoice, not part of a subscription
  return [{ kind: 'record_payment_failure', subscriptionId, invoiceId: invoice.id, at: eventCreated }];
}
