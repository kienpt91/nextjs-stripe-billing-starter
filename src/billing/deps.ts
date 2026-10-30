import type Stripe from 'stripe';
import type { AuthResolver } from '@/lib/auth';
import type { BillingConfig } from '@/lib/config';
import type { BillingRepository } from './types';

/**
 * The slice of the Stripe SDK this app calls. The real `Stripe` instance satisfies it
 * structurally; tests pass a fake for the API calls and keep the real
 * `webhooks` helper so signatures are verified for real.
 */
export interface BillingStripe {
  customers: {
    create(params: Stripe.CustomerCreateParams, options?: Stripe.RequestOptions): Promise<Pick<Stripe.Customer, 'id'>>;
  };
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ): Promise<Pick<Stripe.Checkout.Session, 'id' | 'url'>>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: Stripe.BillingPortal.SessionCreateParams): Promise<Pick<Stripe.BillingPortal.Session, 'url'>>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<Stripe.Subscription>;
    /** Auto-paginating. Without `status`, Stripe lists every subscription that has not been canceled. */
    list(params: Stripe.SubscriptionListParams): AsyncIterable<Pick<Stripe.Subscription, 'id' | 'status'>>;
  };
  webhooks: {
    constructEvent(payload: string | Uint8Array, header: string, secret: string): Stripe.Event;
  };
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface BillingDeps {
  stripe: BillingStripe;
  repo: BillingRepository;
  auth: AuthResolver;
  config: BillingConfig;
  /** Current time in unix seconds. Injected so grace periods and ordering are testable. */
  clock: () => number;
  logger: Logger;
}
