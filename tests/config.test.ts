import { describe, expect, it } from 'vitest';
import { demoHeaderAuth, denyAll } from '@/lib/auth';
import { ConfigError, loadConfig } from '@/lib/config';

const valid = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_123',
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_YEARLY: 'price_y',
};

function problemsFor(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(valid)).toEqual({
      stripeSecretKey: 'sk_test_123',
      webhookSecret: 'whsec_123',
      plans: { monthly: 'price_m', yearly: 'price_y' },
      appUrl: 'http://localhost:3000',
      pastDueGraceDays: 7,
      store: { kind: 'sqlite', path: './data/billing.db' },
      allowDemoAuth: false,
    });
  });

  it('reads every optional setting', () => {
    const config = loadConfig({
      ...valid,
      STRIPE_SECRET_KEY: 'rk_live_restricted',
      APP_URL: 'https://billing.example.com///',
      PAST_DUE_GRACE_DAYS: '2.5',
      BILLING_STORE: 'memory',
      ALLOW_DEMO_AUTH: 'true',
    });
    expect(config).toMatchObject({
      stripeSecretKey: 'rk_live_restricted',
      appUrl: 'https://billing.example.com',
      pastDueGraceDays: 2.5,
      store: { kind: 'memory' },
      allowDemoAuth: true,
    });
  });

  it('uses DATABASE_PATH for SQLite', () => {
    expect(loadConfig({ ...valid, DATABASE_PATH: '/var/lib/app/billing.db' }).store).toEqual({
      kind: 'sqlite',
      path: '/var/lib/app/billing.db',
    });
  });

  it('accepts zero grace days', () => {
    expect(loadConfig({ ...valid, PAST_DUE_GRACE_DAYS: '0' }).pastDueGraceDays).toBe(0);
  });

  it('reports every missing variable in one error', () => {
    expect(problemsFor({})).toEqual([
      'STRIPE_SECRET_KEY is required',
      'STRIPE_WEBHOOK_SECRET is required',
      'STRIPE_PRICE_PRO_MONTHLY is required',
      'STRIPE_PRICE_PRO_YEARLY is required',
    ]);
  });

  it('rejects a publishable key, a price id in the secret slot, and similar mix-ups', () => {
    expect(
      problemsFor({
        ...valid,
        STRIPE_SECRET_KEY: 'pk_test_123',
        STRIPE_WEBHOOK_SECRET: 'sk_test_123',
        STRIPE_PRICE_PRO_MONTHLY: 'prod_123',
      }),
    ).toEqual([
      'STRIPE_SECRET_KEY must start with sk_ or rk_',
      'STRIPE_WEBHOOK_SECRET must start with whsec_',
      'STRIPE_PRICE_PRO_MONTHLY must start with price_',
    ]);
  });

  it.each([
    [{ APP_URL: 'not a url' }, 'APP_URL must be an http(s) URL'],
    [{ APP_URL: 'ftp://example.com' }, 'APP_URL must be an http(s) URL'],
    [{ PAST_DUE_GRACE_DAYS: '-1' }, 'PAST_DUE_GRACE_DAYS must be a non-negative number'],
    [{ PAST_DUE_GRACE_DAYS: 'soon' }, 'PAST_DUE_GRACE_DAYS must be a non-negative number'],
    [{ BILLING_STORE: 'postgres' }, 'BILLING_STORE must be "sqlite" or "memory"'],
  ])('rejects %j', (extra, message) => {
    expect(problemsFor({ ...valid, ...extra })).toEqual([message]);
  });
});

describe('auth resolvers', () => {
  const request = (headers: Record<string, string>) => new Request('http://localhost/', { headers });

  it('denyAll never identifies a user', async () => {
    expect(await denyAll(request({ 'x-demo-user-id': 'user_1' }))).toBeNull();
  });

  it('demoHeaderAuth reads the demo headers and ignores blank ones', async () => {
    expect(await demoHeaderAuth(request({ 'x-demo-user-id': ' user_1 ', 'x-demo-user-email': 'a@example.com' }))).toEqual({
      id: 'user_1',
      email: 'a@example.com',
    });
    expect(await demoHeaderAuth(request({ 'x-demo-user-id': 'user_1' }))).toEqual({ id: 'user_1' });
    expect(await demoHeaderAuth(request({ 'x-demo-user-id': '   ' }))).toBeNull();
    expect(await demoHeaderAuth(request({}))).toBeNull();
  });
});
