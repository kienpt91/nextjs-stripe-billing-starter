import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as checkoutRoute } from '@/app/api/checkout/route';
import { ConfigError } from '@/lib/config';
import { createDepsFromEnv, setDepsForTesting } from '@/lib/container';
import { jsonRequest, userHeaders } from './helpers';

const env = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_123',
  STRIPE_PRICE_PRO_MONTHLY: 'price_m',
  STRIPE_PRICE_PRO_YEARLY: 'price_y',
  BILLING_STORE: 'memory',
};

afterEach(() => {
  setDepsForTesting(undefined);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createDepsFromEnv', () => {
  it('logs a loud warning when demo authentication is enabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const deps = await createDepsFromEnv({ ...env, ALLOW_DEMO_AUTH: 'true' });

    expect(warn).toHaveBeenCalledOnce();
    const entry = JSON.parse(String(warn.mock.calls[0]?.[0])) as { level: string; message: string; warning: string };
    expect(entry).toMatchObject({ level: 'warn', message: 'demo_auth_enabled' });
    expect(entry.warning).toMatch(/never enable this where real users can reach the app/);
    // And it really is the header-trusting resolver.
    expect(await deps.auth(new Request('http://localhost/', { headers: userHeaders('user_1') }))).toEqual({ id: 'user_1' });
  });

  it('stays quiet and ignores identity headers when demo authentication is off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const deps = await createDepsFromEnv(env);

    expect(warn).not.toHaveBeenCalled();
    expect(await deps.auth(new Request('http://localhost/', { headers: userHeaders('user_1') }))).toBeNull();
  });

  it('refuses to build dependencies for demo authentication in production', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(createDepsFromEnv({ ...env, ALLOW_DEMO_AUTH: 'true', NODE_ENV: 'production' })).rejects.toBeInstanceOf(ConfigError);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('route modules with demo authentication in production', () => {
  it('answers 500 billing_not_configured and never honours the demo headers', async () => {
    for (const [name, value] of Object.entries({ ...env, ALLOW_DEMO_AUTH: 'true', NODE_ENV: 'production' })) {
      vi.stubEnv(name, value);
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await checkoutRoute(jsonRequest('http://localhost/api/checkout', { plan: 'monthly' }, userHeaders('user_1')));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'billing_not_configured' });
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/ALLOW_DEMO_AUTH=true is not allowed when NODE_ENV=production/);
  });
});
