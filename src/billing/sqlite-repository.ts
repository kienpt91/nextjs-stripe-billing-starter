import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyEffects, linkCustomer } from './apply-effects';
import type { EffectStore } from './apply-effects';
import type {
  BillingRepository,
  CommitResult,
  Effect,
  SubscriptionRecord,
  WebhookEventMeta,
} from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_customers (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  price_id TEXT,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL,
  state_as_of INTEGER NOT NULL,
  past_due_since INTEGER,
  last_payment_failed_at INTEGER,
  last_failed_invoice_id TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS billing_subscriptions_user_id ON billing_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created INTEGER NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;
`;

type Row = Record<string, string | number | null>;

function toRecord(row: Row): SubscriptionRecord {
  return {
    subscriptionId: row.stripe_subscription_id as string,
    userId: row.user_id as string,
    customerId: row.stripe_customer_id as string,
    status: row.status as string,
    priceId: row.price_id as string | null,
    currentPeriodEnd: row.current_period_end as number | null,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    stateAsOf: row.state_as_of as number,
    pastDueSince: row.past_due_since as number | null,
    lastPaymentFailedAt: row.last_payment_failed_at as number | null,
    lastFailedInvoiceId: row.last_failed_invoice_id as string | null,
  };
}

/**
 * SQLite repository on Node's built-in `node:sqlite`, so there is no native addon to install.
 * The driver is synchronous, which is what makes `commitEvent` a real transaction:
 * nothing else can interleave between BEGIN and COMMIT on this connection.
 */
export class SqliteBillingRepository implements BillingRepository {
  private readonly db: DatabaseSync;
  private readonly store: EffectStore;

  private readonly selectCustomerByUser;
  private readonly selectUserByCustomer;
  private readonly insertCustomer;
  private readonly selectSubscription;
  private readonly selectSubscriptionsByUser;
  private readonly upsertSubscription;
  private readonly selectEvent;
  private readonly insertEvent;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);

    this.selectCustomerByUser = this.db.prepare('SELECT stripe_customer_id FROM billing_customers WHERE user_id = ?');
    this.selectUserByCustomer = this.db.prepare('SELECT user_id FROM billing_customers WHERE stripe_customer_id = ?');
    this.insertCustomer = this.db.prepare('INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES (?, ?)');
    this.selectSubscription = this.db.prepare('SELECT * FROM billing_subscriptions WHERE stripe_subscription_id = ?');
    this.selectSubscriptionsByUser = this.db.prepare('SELECT * FROM billing_subscriptions WHERE user_id = ?');
    this.upsertSubscription = this.db.prepare(`
      INSERT INTO billing_subscriptions (
        stripe_subscription_id, user_id, stripe_customer_id, status, price_id, current_period_end,
        cancel_at_period_end, state_as_of, past_due_since, last_payment_failed_at, last_failed_invoice_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (stripe_subscription_id) DO UPDATE SET
        user_id = excluded.user_id,
        stripe_customer_id = excluded.stripe_customer_id,
        status = excluded.status,
        price_id = excluded.price_id,
        current_period_end = excluded.current_period_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        state_as_of = excluded.state_as_of,
        past_due_since = excluded.past_due_since,
        last_payment_failed_at = excluded.last_payment_failed_at,
        last_failed_invoice_id = excluded.last_failed_invoice_id
    `);
    this.selectEvent = this.db.prepare('SELECT 1 AS found FROM stripe_events WHERE event_id = ?');
    this.insertEvent = this.db.prepare(
      'INSERT OR IGNORE INTO stripe_events (event_id, type, created, received_at) VALUES (?, ?, ?, ?)',
    );

    this.store = {
      getSubscription: (id) => {
        const row = this.selectSubscription.get(id) as Row | undefined;
        return row ? toRecord(row) : null;
      },
      putSubscription: (r) => {
        this.upsertSubscription.run(
          r.subscriptionId,
          r.userId,
          r.customerId,
          r.status,
          r.priceId,
          r.currentPeriodEnd,
          r.cancelAtPeriodEnd ? 1 : 0,
          r.stateAsOf,
          r.pastDueSince,
          r.lastPaymentFailedAt,
          r.lastFailedInvoiceId,
        );
      },
      getCustomerIdForUser: (userId) => {
        const row = this.selectCustomerByUser.get(userId) as Row | undefined;
        return row ? (row.stripe_customer_id as string) : null;
      },
      getUserIdForCustomer: (customerId) => {
        const row = this.selectUserByCustomer.get(customerId) as Row | undefined;
        return row ? (row.user_id as string) : null;
      },
      insertCustomerLink: (userId, customerId) => {
        this.insertCustomer.run(userId, customerId);
      },
    };
  }

  close(): void {
    this.db.close();
  }

  async getStripeCustomerId(userId: string): Promise<string | null> {
    return this.store.getCustomerIdForUser(userId);
  }

  async findUserIdByCustomerId(customerId: string): Promise<string | null> {
    return this.store.getUserIdForCustomer(customerId);
  }

  async linkCustomer(userId: string, customerId: string): Promise<string> {
    return this.transaction(() => linkCustomer(this.store, userId, customerId));
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionRecord | null> {
    return this.store.getSubscription(subscriptionId);
  }

  async listSubscriptionsForUser(userId: string): Promise<SubscriptionRecord[]> {
    return (this.selectSubscriptionsByUser.all(userId) as Row[]).map(toRecord);
  }

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    return this.selectEvent.get(eventId) !== undefined;
  }

  async commitEvent(event: WebhookEventMeta, effects: readonly Effect[]): Promise<CommitResult> {
    return this.transaction((): CommitResult => {
      const claimed = this.insertEvent.run(event.id, event.type, event.created, event.receivedAt).changes === 1;
      if (!claimed) return { status: 'duplicate' };
      const { staleEffects } = applyEffects(this.store, effects);
      return { status: 'applied', staleEffects };
    });
  }

  /** BEGIN IMMEDIATE takes the write lock up front, so concurrent processes serialize here instead of failing on upgrade. */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
