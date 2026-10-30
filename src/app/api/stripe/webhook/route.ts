import { handleStripeWebhook } from '@/billing/handlers/webhook';
import { withDeps } from '@/lib/container';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withDeps(handleStripeWebhook);
