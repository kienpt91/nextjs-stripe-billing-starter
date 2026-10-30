export const PLAN_KEYS = ['monthly', 'yearly'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** What the request handlers need. Everything else in AppConfig is wiring. */
export interface BillingConfig {
  appUrl: string;
  webhookSecret: string;
  /** Plan key from the checkout request body -> Stripe Price id. Clients never send price ids. */
  plans: Record<PlanKey, string>;
  pastDueGraceDays: number;
}

export interface AppConfig extends BillingConfig {
  stripeSecretKey: string;
  store: { kind: 'sqlite'; path: string } | { kind: 'memory' };
  allowDemoAuth: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Parses and validates environment variables, reporting every problem at once. */
export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];

  const required = (name: string, prefixes: readonly string[]): string => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`${name} is required`);
      return '';
    }
    if (!prefixes.some((prefix) => value.startsWith(prefix))) {
      problems.push(`${name} must start with ${prefixes.join(' or ')}`);
    }
    return value;
  };

  const stripeSecretKey = required('STRIPE_SECRET_KEY', ['sk_', 'rk_']);
  const webhookSecret = required('STRIPE_WEBHOOK_SECRET', ['whsec_']);
  const plans: Record<PlanKey, string> = {
    monthly: required('STRIPE_PRICE_PRO_MONTHLY', ['price_']),
    yearly: required('STRIPE_PRICE_PRO_YEARLY', ['price_']),
  };

  let appUrl = env.APP_URL?.trim() || 'http://localhost:3000';
  try {
    const url = new URL(appUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    appUrl = appUrl.replace(/\/+$/, '');
  } catch {
    problems.push('APP_URL must be an http(s) URL');
  }

  const graceRaw = env.PAST_DUE_GRACE_DAYS?.trim();
  const pastDueGraceDays = graceRaw === undefined || graceRaw === '' ? 7 : Number(graceRaw);
  if (!Number.isFinite(pastDueGraceDays) || pastDueGraceDays < 0) {
    problems.push('PAST_DUE_GRACE_DAYS must be a non-negative number');
  }

  const storeKind = env.BILLING_STORE?.trim() || 'sqlite';
  if (storeKind !== 'sqlite' && storeKind !== 'memory') {
    problems.push('BILLING_STORE must be "sqlite" or "memory"');
  }

  const allowDemoAuth = env.ALLOW_DEMO_AUTH === 'true';
  if (allowDemoAuth && env.NODE_ENV === 'production') {
    problems.push(
      'ALLOW_DEMO_AUTH=true is not allowed when NODE_ENV=production: it accepts client-supplied headers as the signed-in user. ' +
        'Unset it and wire a real AuthResolver (README, "Authentication").',
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    appUrl,
    webhookSecret,
    plans,
    pastDueGraceDays,
    stripeSecretKey,
    store: storeKind === 'memory' ? { kind: 'memory' } : { kind: 'sqlite', path: env.DATABASE_PATH?.trim() || './data/billing.db' },
    allowDemoAuth,
  };
}
