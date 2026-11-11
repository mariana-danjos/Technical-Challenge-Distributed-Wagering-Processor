import type { EventPublisher } from '../ports/messaging';
import type { Clock } from '../ports/system';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface PublishOutboxResult {
  claimed: number;
  published: number;
}

/**
 * Transactional outbox relay. Claims a batch of due messages with FOR UPDATE SKIP LOCKED, publishes
 * them, and records the result in the same SQL transaction:
 *   - concurrent publishers claim disjoint batches, so nothing is published twice in normal runs;
 *   - a crash after publishing but before COMMIT leaves the rows pending, so they are published
 *     again — at-least-once, safe because consumers deduplicate by eventId (= outbox id);
 *   - failed sends are rescheduled with backoff and never dropped.
 */
export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly batchSize = 10,
  ) {}

  async publishBatch(): Promise<PublishOutboxResult> {
    return this.unitOfWork.run(async (repositories) => {
      const now = this.clock.now();
      const batch = await repositories.outbox.claimDue(now, this.batchSize);
      if (batch.length === 0) return { claimed: 0, published: 0 };

      let published: ReadonlySet<string>;
      try {
        ({ published } = await this.publisher.publish(batch));
      } catch {
        published = new Set();
      }

      for (const message of batch) {
        if (published.has(message.id)) {
          message.markPublished(this.clock.now());
        } else {
          message.scheduleRetry(now);
        }
        await repositories.outbox.update(message);
      }
      return { claimed: batch.length, published: published.size };
    });
  }
}
