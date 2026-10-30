import { resolveUserEntitlement } from '@/domain/entitlement';
import { json } from '@/lib/http';
import type { BillingDeps } from '../deps';

/** GET /api/entitlement  ->  what the signed-in user may use right now. */
export async function handleEntitlement(request: Request, deps: BillingDeps): Promise<Response> {
  const user = await deps.auth(request);
  if (!user) return json(401, { error: 'unauthorized' });

  const subscriptions = await deps.repo.listSubscriptionsForUser(user.id);
  const { plan, reason, graceEndsAt, subscription } = resolveUserEntitlement(subscriptions, deps.clock(), {
    pastDueGraceDays: deps.config.pastDueGraceDays,
  });

  return json(200, {
    plan,
    reason,
    graceEndsAt,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
    cancelAt: subscription?.cancelAt ?? null,
    lastPaymentFailedAt: subscription?.lastPaymentFailedAt ?? null,
  });
}
