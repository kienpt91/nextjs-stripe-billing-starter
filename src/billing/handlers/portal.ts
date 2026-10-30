import { errorMessage } from '@/lib/errors';
import { json } from '@/lib/http';
import type { BillingDeps } from '../deps';

/** POST /api/portal  ->  { "url": "<Stripe Billing Portal URL>" } */
export async function handlePortal(request: Request, deps: BillingDeps): Promise<Response> {
  const user = await deps.auth(request);
  if (!user) return json(401, { error: 'unauthorized' });

  const customerId = await deps.repo.getStripeCustomerId(user.id);
  if (!customerId) {
    return json(404, { error: 'no_billing_account', message: 'This user has not started a checkout yet.' });
  }

  try {
    const session = await deps.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${deps.config.appUrl}/`,
    });
    return json(200, { url: session.url });
  } catch (error) {
    deps.logger.error('portal_failed', { userId: user.id, error: errorMessage(error) });
    return json(502, { error: 'stripe_error', message: 'Could not open the billing portal. Try again shortly.' });
  }
}
