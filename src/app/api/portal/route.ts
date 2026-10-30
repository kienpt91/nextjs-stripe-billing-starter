import { handlePortal } from '@/billing/handlers/portal';
import { withDeps } from '@/lib/container';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withDeps(handlePortal);
