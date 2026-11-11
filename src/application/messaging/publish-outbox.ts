import type { EventPublisher, PublishResult } from '../ports/messaging';
import type { Clock, Telemetry } from '../ports/system';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface PublishOutboxResult {
  /** Rows locked this round; equal to the batch size means there may be more to drain. */
  claimed: number;
  published: number;
}

/**
 * Transactional outbox relay. Claims a batch of due messages with FOR UPDATE SKIP LOCKED, keeps
 * only those next in line for their aggregate, publishes them, and records the result in the same
 * SQL transaction:
 *   - concurrent publishers claim disjoint batches, so nothing is published twice in normal runs;
 *   - per-wallet order: an event never leaves before an earlier event of the same wallet, whether
 *     that one is held by another publisher or waiting in backoff (head-of-line, like FIFO);
 *   - a crash after publishing but before COMMIT leaves the rows pending, so they are published
 *     again — at-least-once, safe because consumers deduplicate by eventId (= outbox id);
 *   - rejected sends are rescheduled with backoff and never dropped; messages not attempted
 *     (behind a failure of their aggregate) are left untouched.
 */
export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly telemetry: Telemetry,
    private readonly batchSize = 10,
  ) {}

  async publishBatch(): Promise<PublishOutboxResult> {
    const outcome = await this.unitOfWork.run(async (repositories) => {
      const now = this.clock.now();
      const { locked, publishable: batch } = await repositories.outbox.claimDue(now, this.batchSize);
      if (batch.length === 0) return { claimed: locked, published: 0, failedIds: [], error: undefined };

      let result: PublishResult;
      let error: unknown;
      try {
        result = await this.publisher.publish(batch);
      } catch (cause) {
        error = cause;
        result = { published: new Set(), failed: new Set(batch.map((message) => message.id)) };
      }

      for (const message of batch) {
        if (result.published.has(message.id)) {
          message.markPublished(this.clock.now());
        } else if (result.failed.has(message.id)) {
          message.scheduleRetry(now);
        } else {
          continue;
        }
        await repositories.outbox.update(message);
      }
      return {
        claimed: locked,
        published: result.published.size,
        failedIds: [...result.failed],
        error: error ?? new Error('Broker rejected messages'),
      };
    });

    // After COMMIT, so the signal never reports a retry that was rolled back.
    if (outcome.failedIds.length > 0) {
      this.telemetry.outboxPublishFailed({ messageIds: outcome.failedIds, error: outcome.error });
    }
    return { claimed: outcome.claimed, published: outcome.published };
  }
}
