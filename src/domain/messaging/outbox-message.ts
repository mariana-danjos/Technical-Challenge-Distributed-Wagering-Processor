import type { IntegrationEvent } from '../events/integration-event';
import { addMilliseconds, exponentialBackoffDelay, type BackoffPolicy } from '../shared/backoff';
import { InvalidTransactionStateError } from '../shared/domain-error';

/** Publish retries: ~1s, 2s, 4s… capped at 5 min. Outbox never gives up — events must not be lost. */
export const OUTBOX_RETRY_POLICY: BackoffPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
};

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
  ) {}

  /** The outbox id is the event id, so a duplicate publish carries the same id downstream. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...event.toJSON() }),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    this._publishedAt = at;
  }

  /** Increments attempts and computes the next nextAttemptAt (exponential backoff). */
  scheduleRetry(now: Date): void {
    this.assertPending('scheduleRetry');
    this._attempts += 1;
    this._nextAttemptAt = addMilliseconds(
      now,
      exponentialBackoffDelay(this._attempts, OUTBOX_RETRY_POLICY),
    );
  }

  private assertPending(action: string): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`Cannot ${action}: outbox message ${this.id} is published`);
    }
  }
}
