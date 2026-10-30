import { handleEntitlement } from '@/billing/handlers/entitlement';
import { withDeps } from '@/lib/container';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withDeps(handleEntitlement);
