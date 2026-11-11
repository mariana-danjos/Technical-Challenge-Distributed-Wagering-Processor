import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

export interface PublishResult {
  /** Outbox ids accepted by the broker. Anything not listed is retried. */
  published: ReadonlySet<string>;
}

/** Broker side of the transactional outbox. Must be safe to call twice for the same message. */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}
