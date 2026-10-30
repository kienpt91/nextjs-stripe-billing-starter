import { applyEffects, linkCustomer } from './apply-effects';
import type { EffectStore } from './apply-effects';
import type {
  BillingRepository,
  CommitResult,
  Effect,
  SubscriptionRecord,
  WebhookEventMeta,
} from './types';

/** Process-local repository for tests and local experiments. State is lost on restart. */
export class InMemoryBillingRepository implements BillingRepository {
  private customerByUser = new Map<string, string>();
  private userByCustomer = new Map<string, string>();
  private subscriptions = new Map<string, SubscriptionRecord>();
  private readonly events = new Map<string, WebhookEventMeta>();

  private readonly store: EffectStore = {
    getSubscription: (id) => this.subscriptions.get(id) ?? null,
    putSubscription: (record) => {
      this.subscriptions.set(record.subscriptionId, record);
    },
    getCustomerIdForUser: (userId) => this.customerByUser.get(userId) ?? null,
    getUserIdForCustomer: (customerId) => this.userByCustomer.get(customerId) ?? null,
    insertCustomerLink: (userId, customerId) => {
      this.customerByUser.set(userId, customerId);
      this.userByCustomer.set(customerId, userId);
    },
  };

  async getStripeCustomerId(userId: string): Promise<string | null> {
    return this.customerByUser.get(userId) ?? null;
  }

  async findUserIdByCustomerId(customerId: string): Promise<string | null> {
    return this.userByCustomer.get(customerId) ?? null;
  }

  async linkCustomer(userId: string, customerId: string): Promise<string> {
    return linkCustomer(this.store, userId, customerId);
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionRecord | null> {
    return this.subscriptions.get(subscriptionId) ?? null;
  }

  async listSubscriptionsForUser(userId: string): Promise<SubscriptionRecord[]> {
    return [...this.subscriptions.values()].filter((record) => record.userId === userId);
  }

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
  }

  async commitEvent(event: WebhookEventMeta, effects: readonly Effect[]): Promise<CommitResult> {
    if (this.events.has(event.id)) return { status: 'duplicate' };

    // Copy-and-restore keeps the commit all-or-nothing, matching the SQLite transaction.
    const backup = [this.customerByUser, this.userByCustomer, this.subscriptions] as const;
    this.customerByUser = new Map(backup[0]);
    this.userByCustomer = new Map(backup[1]);
    this.subscriptions = new Map(backup[2]);
    try {
      const { staleEffects } = applyEffects(this.store, effects);
      this.events.set(event.id, event);
      return { status: 'applied', staleEffects };
    } catch (error) {
      [this.customerByUser, this.userByCustomer, this.subscriptions] = backup;
      throw error;
    }
  }
}
