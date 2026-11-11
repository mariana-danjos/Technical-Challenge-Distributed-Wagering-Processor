import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

export interface PublishResult {
  /** Outbox ids accepted by the broker. */
  published: ReadonlySet<string>;
  /** Outbox ids the broker rejected; retried with backoff. Ids in neither set were not attempted. */
  failed: ReadonlySet<string>;
}

/**
 * Broker side of the transactional outbox. Must be safe to call twice for the same message, and
 * must publish each aggregate's messages in the given order, stopping that aggregate at its first
 * failure.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}
