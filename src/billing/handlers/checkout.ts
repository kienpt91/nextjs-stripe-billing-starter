import type Stripe from 'stripe';
import { isLiveSubscriptionStatus } from '@/domain/entitlement';
import type { AuthUser } from '@/lib/auth';
import { PLAN_KEYS } from '@/lib/config';
import type { PlanKey } from '@/lib/config';
import { errorMessage } from '@/lib/errors';
import { json } from '@/lib/http';
import type { BillingDeps } from '../deps';

/**
 * POST /api/checkout  { "plan": "monthly" | "yearly" }  ->  { "url": "<Stripe Checkout URL>" }
 */
export async function handleCheckout(request: Request, deps: BillingDeps): Promise<Response> {
  const user = await deps.auth(request);
  if (!user) return json(401, { error: 'unauthorized' });

  const plan = await readPlan(request);
  if (plan === null) {
    return json(400, { error: 'invalid_request', message: `Body must be JSON like {"plan":"${PLAN_KEYS[0]}"}; plan is one of: ${PLAN_KEYS.join(', ')}` });
  }

  // A second Checkout would create a second, parallel subscription and bill the customer twice.
  // Cheap check against our own records first; Stripe itself is asked below, once we know the customer.
  const existing = await deps.repo.listSubscriptionsForUser(user.id);
  if (existing.some((subscription) => isLiveSubscriptionStatus(subscription.status))) {
    return json(409, { error: 'already_subscribed', message: 'Manage the current subscription in the billing portal.' });
  }

  try {
    const existingCustomerId = await deps.repo.getStripeCustomerId(user.id);
    if (existingCustomerId && (await hasLiveStripeSubscription(deps, existingCustomerId))) {
      return json(409, { error: 'already_subscribed', message: 'Manage the current subscription in the billing portal.' });
    }
    const customerId = await ensureStripeCustomer(deps, user, existingCustomerId);
    const session = await deps.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: deps.config.plans[plan], quantity: 1 }],
      // Stripe Tax decides the rate from the customer's location, so the address must be collected...
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      // ...and, because an existing Customer is passed, Stripe requires permission to save what was
      // entered: the address for tax calculation, the business name for tax ID collection.
      customer_update: { address: 'auto', name: 'auto' },
      // The subscription (and so every subscription webhook) carries the user id, which lets the
      // webhook resolve the owner even if it arrives before the customer link is stored.
      subscription_data: { metadata: { user_id: user.id } },
      success_url: `${deps.config.appUrl}/?checkout=success`,
      cancel_url: `${deps.config.appUrl}/?checkout=cancelled`,
    });
    if (!session.url) throw new Error(`Checkout Session ${session.id} has no url`);
    return json(200, { url: session.url });
  } catch (error) {
    deps.logger.error('checkout_failed', { userId: user.id, error: errorMessage(error) });
    return json(502, { error: 'stripe_error', message: 'Could not start checkout. Try again shortly.' });
  }
}

async function readPlan(request: Request): Promise<PlanKey | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  const plan = (body as { plan?: unknown } | null)?.plan;
  return PLAN_KEYS.find((key) => key === plan) ?? null;
}

/** One Stripe customer per app user. Reused on every later checkout. */
async function ensureStripeCustomer(deps: BillingDeps, user: AuthUser, existing: string | null): Promise<string> {
  if (existing) return existing;

  const params: Stripe.CustomerCreateParams = { metadata: { user_id: user.id } };
  if (user.email) params.email = user.email;
  // The idempotency key makes two simultaneous first checkouts converge on one Stripe customer.
  const customer = await deps.stripe.customers.create(params, { idempotencyKey: `billing-customer-${user.id}` });
  return deps.repo.linkCustomer(user.id, customer.id);
}

/**
 * Asks Stripe, not our database, whether the customer already has a live subscription. Our copy
 * only updates when a webhook arrives, so right after a purchase it can still say "none".
 */
async function hasLiveStripeSubscription(deps: BillingDeps, customerId: string): Promise<boolean> {
  for await (const subscription of deps.stripe.subscriptions.list({ customer: customerId, limit: 100 })) {
    if (isLiveSubscriptionStatus(subscription.status)) return true;
  }
  return false;
}

