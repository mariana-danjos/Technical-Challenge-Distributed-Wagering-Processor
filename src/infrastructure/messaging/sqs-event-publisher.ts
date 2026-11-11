import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type { EventPublisher, PublishResult } from '../../application/ports/messaging';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

const SQS_BATCH_LIMIT = 10;

/**
 * Total time budget for one publish(). The relay calls it inside an open SQL transaction, which
 * PostgreSQL ends after `idle_in_transaction_session_timeout` (30s): staying well below it lets the
 * relay always record what it did publish, instead of being cut off and re-sending everything.
 */
export const PUBLISH_DEADLINE_MS = 20_000;

/**
 * Publishes outbox messages to a FIFO queue. MessageGroupId = aggregateId (walletId) keeps per-wallet
 * order; MessageDeduplicationId = eventId lets the broker drop re-sends within its 5-minute window.
 * Broker dedup is an optimization only — consumers must still deduplicate by eventId.
 *
 * Aggregates are sent concurrently; each one's messages are sent in order and stop at the first
 * rejected entry, failed call or the deadline, so a later event is never sent after an earlier one
 * failed. Messages never attempted are reported in neither set (left untouched). Residual risk:
 * within one SendMessageBatch, SQS may accept entries after a rejected one; the envelope's
 * `sequence` lets consumers detect it.
 */
export class SqsEventPublisher implements EventPublisher {
  private readonly logger = new Logger(SqsEventPublisher.name);

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: () => Promise<string>,
    private readonly deadlineMs = PUBLISH_DEADLINE_MS,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const queueUrl = await this.queueUrl();
    const published = new Set<string>();
    const failed = new Set<string>();
    const deadline = AbortSignal.timeout(this.deadlineMs);

    const byAggregate = new Map<string, OutboxMessage[]>();
    for (const message of messages) {
      byAggregate.set(message.aggregateId, [...(byAggregate.get(message.aggregateId) ?? []), message]);
    }

    await Promise.all(
      [...byAggregate.values()].map((aggregateMessages) =>
        this.publishAggregate(queueUrl, aggregateMessages, deadline, published, failed),
      ),
    );
    return { published, failed };
  }

  private async publishAggregate(
    queueUrl: string,
    messages: OutboxMessage[],
    deadline: AbortSignal,
    published: Set<string>,
    failed: Set<string>,
  ): Promise<void> {
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      if (deadline.aborted) return; // the rest stays untouched for the next round
      const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
      try {
        const response = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((message) => ({
              Id: message.id,
              MessageBody: JSON.stringify({ ...message.payload, sequence: message.sequence }),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: message.eventType },
              },
            })),
          }),
          { abortSignal: deadline },
        );
        for (const entry of response.Successful ?? []) {
          if (entry.Id) published.add(entry.Id);
        }
        const rejected = response.Failed ?? [];
        if (rejected.length > 0) {
          for (const entry of rejected) {
            if (entry.Id) failed.add(entry.Id);
          }
          this.logger.error(
            {
              failed: rejected.map(({ Id, Code, SenderFault, Message }) => ({ Id, Code, SenderFault, Message })),
            },
            'SQS rejected outbox messages',
          );
          return; // later events of this aggregate must not overtake the rejected one
        }
      } catch (error) {
        // Unknown outcome (network, timeout, deadline): retry the chunk; dedup id = eventId makes a
        // re-send of an entry SQS did accept harmless within its window.
        for (const message of chunk) failed.add(message.id);
        this.logger.error({ err: error, count: chunk.length }, 'SQS publish call failed');
        return;
      }
    }
  }
}
