import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/ports/messaging';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes outbox messages to a FIFO queue. MessageGroupId = aggregateId (walletId) keeps per-wallet
 * order; MessageDeduplicationId = eventId lets the broker drop re-sends within its 5-minute window.
 * Broker dedup is an optimization only — consumers must still deduplicate by eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: () => Promise<string>,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const queueUrl = await this.queueUrl();
    const published = new Set<string>();

    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
      const response = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((message) => ({
            Id: message.id,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
            },
          })),
        }),
      );
      for (const entry of response.Successful ?? []) {
        if (entry.Id) published.add(entry.Id);
      }
    }
    return { published };
  }
}
