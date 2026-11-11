// Requires `docker compose up -d postgres localstack`. Whole pipeline (SQS consumer → use case →
// outbox relay → events queue, plus the pending-reference resolver) is stopped mid-stream and a
// fresh instance takes over; the final state must be consistent and no confirmed event lost.
import type { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PublishOutbox } from '../../src/application/messaging/publish-outbox';
import { ResolvePendingReferences } from '../../src/application/wagering/resolve-pending-references';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { SqsQueueConsumer } from '../../src/infrastructure/messaging/sqs-queue-consumer';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system/system-adapters';
import { PollingLoop } from '../../src/infrastructure/workers/polling-loop';
import { WagerTransactionMessageHandler } from '../../src/interfaces/messaging/wager-transaction-message-handler';
import {
  createSqsClient,
  createTestQueues,
  drain,
  send,
  sleep,
  wagerMessage,
  waitFor,
  type TestQueues,
} from '../support/messaging-harness';
import {
  createWageringHarness,
  expectLedgerConsistent,
  openTestWallet,
  type WageringHarness,
} from '../support/wagering-harness';

const CONSUMER = 'wager-transactions-consumer';

let harness: WageringHarness;
let sqs: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  harness = await createWageringHarness();
  sqs = createSqsClient();
  queues = await createTestQueues(sqs);
  await harness.sql`update outbox_messages set published_at = now() where published_at is null`;
});

afterAll(async () => {
  await queues?.delete();
  sqs?.destroy();
  await harness?.close();
});

/** What WorkersService runs in each app instance, wired to this test's queues. */
function startInstance(onSettled?: () => void) {
  const unitOfWork = new MikroOrmUnitOfWork(harness.orm);
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  const consumer = new SqsQueueConsumer(sqs, new WagerTransactionMessageHandler(harness.submit, CONSUMER), {
    queueUrl: queues.queueUrl,
    dlqUrl: queues.dlqUrl,
    waitTimeSeconds: 1,
    onSettled,
  });
  const outbox = new PublishOutbox(
    unitOfWork,
    new SqsEventPublisher(sqs, async () => queues.eventsUrl),
    clock,
    harness.telemetry,
  );
  const resolver = new ResolvePendingReferences(unitOfWork, clock, ids, harness.telemetry);
  const loops = [
    new PollingLoop('outbox', async () => (await outbox.publishBatch()).claimed === 10, 50),
    new PollingLoop('pending', async () => (await resolver.processDue(20)) === 20, 100),
  ];
  consumer.start();
  for (const loop of loops) loop.start();
  return { stop: () => Promise.all([consumer.stop(), ...loops.map((loop) => loop.stop())]) };
}

describe('restart recovery', () => {
  it('a second instance finishes the work of a stopped one; balances, ledger and events end consistent', async () => {
    const wallets = await Promise.all([1, 2, 3, 4].map(() => openTestWallet(harness, '100.00')));
    const messages = wallets.flatMap((wallet) => {
      const bets = Array.from({ length: 4 }, () => wagerMessage(wallet, 'BET', '5.00'));
      // A REFUND delivered BEFORE the BET it reverses (out of order on purpose).
      const lateBet = wagerMessage(wallet, 'BET', '10.00');
      const earlyRefund = wagerMessage(wallet, 'REFUND', '10.00', {
        data: { referenceExternalTransactionId: lateBet.data.externalTransactionId },
      });
      return [...bets.slice(0, 2), earlyRefund, ...bets.slice(2), lateBet];
    });
    for (const message of messages) await send(sqs, queues.queueUrl, message, message.data.walletId);

    let settled = 0;
    const first = startInstance(() => (settled += 1));
    await waitFor(async () => settled >= 6);
    await first.stop(); // shutdown in the middle of the stream

    const second = startInstance();
    const walletIds = wallets.map((w) => w.id);
    await waitFor(async () => {
      const [row] = await harness.sql`
        select count(*) filter (where status = 'PROCESSED')::int as processed,
               count(*) filter (where status = 'PENDING_REFERENCE')::int as pending
          from wager_transactions where wallet_id in ${harness.sql(walletIds)} and kind <> 'OPENING'`;
      const [unpublished] = await harness.sql`
        select count(*)::int as n from outbox_messages
         where aggregate_id in ${harness.sql(walletIds)} and published_at is null`;
      return row.processed === messages.length && row.pending === 0 && unpublished.n === 0;
    }, 30_000);
    await second.stop();
    await sleep(100);

    // Every wallet: 4×5.00 bets, and the 10.00 bet refunded → 80.00, ledger agrees.
    for (const wallet of wallets) {
      expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('80.00');
    }
    // Each delivery recorded once in the inbox, no transaction applied twice.
    const [inbox] = await harness.sql`
      select count(*)::int as n from inbox_messages
       where message_id in ${harness.sql(messages.map((m) => m.messageId))}`;
    expect(inbox.n).toBe(messages.length);

    // No confirmed event lost: every committed outbox row reached the events queue.
    const outboxIds = (
      await harness.sql`select id from outbox_messages where aggregate_id in ${harness.sql(walletIds)}`
    ).map((row: { id: string }) => row.id);
    const delivered = new Set((await drain(sqs, queues.eventsUrl)).map((m) => JSON.parse(m.Body!).eventId));
    expect(outboxIds.length).toBeGreaterThan(messages.length);
    for (const id of outboxIds) expect(delivered.has(id)).toBe(true);
  }, 60_000);
});
