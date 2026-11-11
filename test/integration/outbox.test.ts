// Requires `docker compose up -d postgres localstack`. Outbox relay against real PostgreSQL and
// real LocalStack SQS: concurrent publishers, crash between publish and commit, publish failures.
import type { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PublishOutbox } from '../../src/application/messaging/publish-outbox';
import type { EventPublisher } from '../../src/application/ports/messaging';
import type { Repositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../src/infrastructure/system/system-adapters';
import { createSqsClient, createTestQueues, drain, type TestQueues } from '../support/messaging-harness';
import {
  createWageringHarness,
  openTestWallet,
  wagerCommand,
  type WageringHarness,
} from '../support/wagering-harness';

let harness: WageringHarness;
let sqs: SQSClient;
let queues: TestQueues;
let unitOfWork: MikroOrmUnitOfWork;
const clock = new SystemClock();

beforeAll(async () => {
  harness = await createWageringHarness();
  sqs = createSqsClient();
  queues = await createTestQueues(sqs);
  unitOfWork = new MikroOrmUnitOfWork(harness.orm);
});

beforeEach(async () => {
  // Earlier test files leave pending events in the shared test DB; mark them out of the way so
  // each test only publishes what it created.
  await harness.sql`update outbox_messages set published_at = now() where published_at is null`;
});

afterAll(async () => {
  await queues?.delete();
  sqs?.destroy();
  await harness?.close();
});

/** Records every message id handed to the broker, across publishers. */
class RecordingPublisher implements EventPublisher {
  constructor(
    private readonly inner: EventPublisher,
    readonly sent: string[],
  ) {}

  async publish(messages: readonly OutboxMessage[]) {
    this.sent.push(...messages.map((m) => m.id));
    return this.inner.publish(messages);
  }
}

/** Simulates the process dying after the work ran but before COMMIT. */
class CrashBeforeCommit implements UnitOfWork {
  constructor(private readonly inner: UnitOfWork) {}

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.inner.run(async (repositories) => {
      await work(repositories);
      throw new Error('process killed before COMMIT');
    });
  }
}

/** Rejects one message the first time it is offered (like an SQS entry failure); stops its aggregate. */
class RejectOnce implements EventPublisher {
  private rejected = false;

  constructor(
    private readonly inner: EventPublisher,
    private readonly targetId: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]) {
    const index = messages.findIndex((m) => m.id === this.targetId);
    if (this.rejected || index < 0) return this.inner.publish(messages);
    this.rejected = true;
    const before = await this.inner.publish(messages.slice(0, index));
    return { published: before.published, failed: new Set([this.targetId]) };
  }
}

async function outboxOrder(walletId: string): Promise<string[]> {
  const rows = await harness.sql`
    select id from outbox_messages where aggregate_id = ${walletId} order by sequence`;
  return rows.map((row: { id: string }) => row.id);
}

const sqsPublisher = () => new SqsEventPublisher(sqs, async () => queues.eventsUrl);

async function generateEvents(bets: number): Promise<string[]> {
  return (await generateWalletEvents(bets)).ids;
}

async function generateWalletEvents(bets: number) {
  const wallet = await openTestWallet(harness, '1000.00');
  for (let i = 0; i < bets; i++) {
    await harness.submit.execute(wagerCommand(wallet, 'BET', '1.00'));
  }
  return { walletId: wallet.id, ids: await outboxOrder(wallet.id) };
}

async function outboxState(ids: string[]) {
  return harness.sql`
    select id, attempts, published_at is not null as published, next_attempt_at
      from outbox_messages where id in ${harness.sql(ids)}`;
}

describe('outbox relay', () => {
  it('two concurrent publishers publish every event exactly once', async () => {
    const ids = await generateEvents(15); // 1 opening + 15 × (Processed + BalanceChanged) = 31
    expect(ids).toHaveLength(31);
    const sent: string[] = [];
    const publishers = [1, 2].map(
      () => new PublishOutbox(unitOfWork, new RecordingPublisher(sqsPublisher(), sent), clock, harness.telemetry, 5),
    );

    await Promise.all(
      publishers.map(async (publisher) => {
        while ((await publisher.publishBatch()).claimed > 0);
      }),
    );

    expect(sent.toSorted()).toEqual(ids.toSorted()); // no event handed to the broker twice
    const state = await outboxState(ids);
    expect(state.every((row: { published: boolean; attempts: number }) => row.published && row.attempts === 0)).toBe(true);

    const delivered = await drain(sqs, queues.eventsUrl);
    const envelopes = delivered.map((m) => JSON.parse(m.Body!));
    expect(envelopes.map((e) => e.eventId).toSorted()).toEqual(ids.toSorted());
    expect(envelopes[0]).toMatchObject({ eventType: expect.any(String), version: 1, data: expect.any(Object) });
  });

  it('crash after publishing but before COMMIT: events stay pending and are re-published with the same eventId', async () => {
    const ids = await generateEvents(2);
    const sent: string[] = [];

    const crashing = new PublishOutbox(new CrashBeforeCommit(unitOfWork), new RecordingPublisher(sqsPublisher(), sent), clock, harness.telemetry);
    await expect(crashing.publishBatch()).rejects.toThrow('process killed before COMMIT');
    expect((await outboxState(ids)).some((row: { published: boolean }) => row.published)).toBe(false);

    const recovered = new PublishOutbox(unitOfWork, new RecordingPublisher(sqsPublisher(), sent), clock, harness.telemetry);
    while ((await recovered.publishBatch()).claimed > 0);

    expect(sent.toSorted()).toEqual([...ids, ...ids].toSorted()); // each id sent exactly twice
    expect((await outboxState(ids)).every((row: { published: boolean }) => row.published)).toBe(true);
    // The FIFO queue dedups the re-send by MessageDeduplicationId (= eventId); consumers must
    // still dedup by eventId, since that window is only 5 minutes.
    const delivered = await drain(sqs, queues.eventsUrl);
    expect(delivered.map((m) => JSON.parse(m.Body!).eventId).toSorted()).toEqual(ids.toSorted());
  });

  it('per-wallet order holds with concurrent publishers: events reach the queue in sequence order', async () => {
    const { walletId, ids } = await generateWalletEvents(10); // 21 events, one FIFO group
    const publishers = [1, 2, 3].map(
      () => new PublishOutbox(unitOfWork, sqsPublisher(), clock, harness.telemetry, 2),
    );

    // Run until nothing is left: a publisher blocked behind another one's batch may see 0 early.
    for (let round = 0; round < 50 && (await outboxState(ids)).some((r: { published: boolean }) => !r.published); round++) {
      await Promise.all(publishers.map((publisher) => publisher.publishBatch()));
    }

    const delivered = (await drain(sqs, queues.eventsUrl)).map((m) => JSON.parse(m.Body!));
    expect(delivered.map((e) => e.eventId)).toEqual(ids);
    expect(delivered.every((e) => e.aggregateId === walletId)).toBe(true);
    const sequences = delivered.map((e) => BigInt(e.sequence));
    expect(sequences).toEqual(sequences.toSorted((a, b) => (a < b ? -1 : 1)));
  });

  it('an event in backoff holds back the later events of its wallet (head of line)', async () => {
    const { ids } = await generateWalletEvents(3); // opening + 3 × 2 = 7 events
    const second = ids[1]!;
    const flaky = new PublishOutbox(unitOfWork, new RejectOnce(sqsPublisher(), second), clock, harness.telemetry);

    await flaky.publishBatch();

    const state = new Map((await outboxState(ids)).map((r: { id: string }) => [r.id, r]));
    expect(state.get(ids[0]!)).toMatchObject({ published: true });
    expect(state.get(second)).toMatchObject({ published: false, attempts: 1 });
    for (const id of ids.slice(2)) expect(state.get(id)).toMatchObject({ published: false, attempts: 0 });
    expect(harness.telemetry.outboxPublishFailures.at(-1)?.messageIds).toEqual([second]);
    // Later events are due, but must not overtake the one in backoff.
    expect((await flaky.publishBatch()).claimed).toBe(0);

    await harness.sql`update outbox_messages set next_attempt_at = ${new Date()} where id = ${second}`;
    while ((await flaky.publishBatch()).claimed > 0);

    const delivered = (await drain(sqs, queues.eventsUrl)).map((m) => JSON.parse(m.Body!).eventId);
    expect(delivered).toEqual(ids);
  });

  it('a wallet stuck behind an event in backoff does not starve the other wallets', async () => {
    const stuck = await generateWalletEvents(5); // 11 events
    const flaky = new PublishOutbox(unitOfWork, new RejectOnce(sqsPublisher(), stuck.ids[0]!), clock, harness.telemetry, 3);
    await flaky.publishBatch(); // head of `stuck` goes to backoff
    const other = await generateWalletEvents(1); // 3 events, created later (higher sequences)

    const relay = new PublishOutbox(unitOfWork, sqsPublisher(), clock, harness.telemetry, 3);
    const result = await relay.publishBatch();

    expect(result.published).toBe(3);
    expect((await outboxState(other.ids)).every((r: { published: boolean }) => r.published)).toBe(true);
    expect((await outboxState(stuck.ids)).some((r: { published: boolean }) => r.published)).toBe(false);
    await drain(sqs, queues.eventsUrl);
  });

  it('a publish that exceeds its deadline returns promptly and leaves the events pending', async () => {
    const ids = await generateEvents(2);
    const hurried = new PublishOutbox(
      unitOfWork,
      new SqsEventPublisher(sqs, async () => queues.eventsUrl, 1),
      clock,
      harness.telemetry,
    );
    const started = Date.now();

    await hurried.publishBatch();

    expect(Date.now() - started).toBeLessThan(5_000);
    const state = await outboxState(ids);
    expect(state.every((r: { published: boolean; attempts: number }) => !r.published && r.attempts <= 1)).toBe(true);
    // Once due again, a normal relay publishes them all.
    await harness.sql`update outbox_messages set next_attempt_at = ${new Date()} where id in ${harness.sql(ids)}`;
    const relay = new PublishOutbox(unitOfWork, sqsPublisher(), clock, harness.telemetry);
    while ((await relay.publishBatch()).claimed > 0);
    expect((await outboxState(ids)).every((r: { published: boolean }) => r.published)).toBe(true);
    await drain(sqs, queues.eventsUrl);
  });

  it('a failed publish is rescheduled with backoff, never dropped', async () => {
    const ids = await generateEvents(1);
    const broken = new PublishOutbox(
      unitOfWork,
      new SqsEventPublisher(sqs, async () => `${queues.eventsUrl}-does-not-exist`),
      clock,
      harness.telemetry,
    );
    const before = new Date();

    const result = await broken.publishBatch();

    expect(result).toEqual({ claimed: 3, published: 0 });
    const state = await outboxState(ids);
    for (const row of state) {
      expect(row).toMatchObject({ attempts: 1, published: false });
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThanOrEqual(before.getTime() + 1_000);
    }
    // Not due yet: an immediate second pass does not touch them.
    expect((await new PublishOutbox(unitOfWork, sqsPublisher(), clock, harness.telemetry).publishBatch()).claimed).toBe(0);
  });
});
