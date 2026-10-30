import Stripe from 'stripe';
import { InMemoryBillingRepository } from '@/billing/memory-repository';
import type { BillingDeps, Logger } from '@/billing/deps';
import type { BillingRepository } from '@/billing/types';
import { demoHeaderAuth, denyAll } from './auth';
import { ConfigError, loadConfig } from './config';
import type { AppConfig } from './config';
import { json } from './http';

const consoleLogger: Logger = {
  info: (message, fields) => console.info(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
};

async function createRepository(store: AppConfig['store']): Promise<BillingRepository> {
  if (store.kind === 'memory') return new InMemoryBillingRepository();
  // Imported lazily so `node:sqlite` (and its experimental-feature warning) is only loaded when SQLite is used.
  const { SqliteBillingRepository } = await import('@/billing/sqlite-repository');
  return new SqliteBillingRepository(store.path);
}

export async function createDepsFromEnv(env: Record<string, string | undefined>): Promise<BillingDeps> {
  const config = loadConfig(env);
  if (config.allowDemoAuth) {
    consoleLogger.warn('demo_auth_enabled', {
      warning:
        'ALLOW_DEMO_AUTH=true: any client can act as any user by sending an x-demo-user-id header. ' +
        'Local development only; never enable this where real users can reach the app.',
    });
  }
  return {
    stripe: new Stripe(config.stripeSecretKey, {
      maxNetworkRetries: 2,
      appInfo: { name: 'nextjs-stripe-billing-starter' },
    }),
    repo: await createRepository(config.store),
    auth: config.allowDemoAuth ? demoHeaderAuth : denyAll,
    config,
    clock: () => Math.floor(Date.now() / 1000),
    logger: consoleLogger,
  };
}

// Next.js can evaluate this module once per route bundle. Parking the promise on
// globalThis gives every route the same repository, which matters most for the in-memory store.
const DEPS_KEY = Symbol.for('nextjs-stripe-billing-starter.deps');
type GlobalWithDeps = typeof globalThis & { [DEPS_KEY]?: Promise<BillingDeps> };

export function getDeps(): Promise<BillingDeps> {
  const holder = globalThis as GlobalWithDeps;
  holder[DEPS_KEY] ??= createDepsFromEnv(process.env);
  return holder[DEPS_KEY];
}

/** Replaces (or, with undefined, clears) the process-wide dependencies. Used by tests. */
export function setDepsForTesting(deps: BillingDeps | undefined): void {
  (globalThis as GlobalWithDeps)[DEPS_KEY] = deps ? Promise.resolve(deps) : undefined;
}

/** Adapts a framework-free handler to a route export, turning bad configuration into a clean 500. */
export function withDeps(handler: (request: Request, deps: BillingDeps) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    let deps: BillingDeps;
    try {
      deps = await getDeps();
    } catch (error) {
      // Do not cache the failure: fixing the environment and retrying should work without a restart.
      setDepsForTesting(undefined);
      if (error instanceof ConfigError) {
        consoleLogger.error('billing_not_configured', { problems: error.problems });
        return json(500, { error: 'billing_not_configured' });
      }
      throw error;
    }
    return handler(request, deps);
  };
}
