import { handleCheckout } from '@/billing/handlers/checkout';
import { withDeps } from '@/lib/container';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withDeps(handleCheckout);
