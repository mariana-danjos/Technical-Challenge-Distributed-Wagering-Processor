// Requires `docker compose up -d postgres localstack`. The SQS consumer against real LocalStack SQS
// and real PostgreSQL: inbox dedup, ack-after-commit, retry/DLQ classification, crash and shutdown.
import { ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SubmitWagerTransaction } from '../../src/application/wagering/submit-wager-transaction';
import {
  SqsQueueConsumer,
  type MessageAction,
  type MessageHandler,
  type SqsQueueConsumerOptions,
} from '../../src/infrastructure/messaging/sqs-queue-consumer';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system/system-adapters';
import { WagerTransactionMessageHandler } from '../../src/interfaces/messaging/wager-transaction-message-handler';
import {
  createSqsClient,
  createTestQueues,
  drain,
  send,
  sleep,
  wagerMessage,
  type TestQueues,
} from '../support/messaging-harness';
import {
  countRows,
  createWageringHarness,
  expectLedgerConsistent,
  holdWalletLock,
  openTestWallet,
  type WageringHarness,
} from '../support/wagering-harness';

const CONSUMER = 'wager-transactions-consumer';

let harness: WageringHarness;
let sqs: SQSClient;
let queues: TestQueues;
let handler: WagerTransactionMessageHandler;

beforeAll(async () => {
  harness = await createWageringHarness();
  sqs = createSqsClient();
  queues = await createTestQueues(sqs, 3);
  handler = new WagerTransactionMessageHandler(harness.submit, CONSUMER);
});

afterAll(async () => {
  await queues?.delete();
  sqs?.destroy();
  await harness?.close();
});

function consumer(options: Partial<SqsQueueConsumerOptions> = {}, messageHandler: MessageHandler = handler) {
  const settled: Array<{ messageId: string; action: MessageAction }> = [];
  const instance = new SqsQueueConsumer(sqs, messageHandler, {
    queueUrl: queues.queueUrl,
    dlqUrl: queues.dlqUrl,
    waitTimeSeconds: 1,
    retryBaseDelaySeconds: 1,
    onSettled: (messageId, action) => settled.push({ messageId, action }),
    ...options,
  });
  return { instance, settled };
}

async function inboxRows(messageId: string): Promise<number> {
  const [row] = await harness.sql`
    select count(*)::int as n from inbox_messages where consumer_name = ${CONSUMER} and message_id = ${messageId}`;
  return row.n;
}

async function queueIsEmpty(url: string): Promise<boolean> {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 1, VisibilityTimeout: 0 }),
  );
  return Messages.length === 0;
}

describe('SQS consumer', () => {
  it('applies the operation through the shared use case and acks after commit', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const message = wagerMessage(wallet, 'BET', '25.00');
    await send(sqs, queues.queueUrl, message, wallet.id);

    const { instance, settled } = consumer();
    await instance.pollOnce();

    expect(settled.map((s) => s.action.kind)).toEqual(['ack']);
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('75.00');
    expect(await inboxRows(message.messageId)).toBe(1);
    expect(await queueIsEmpty(queues.queueUrl)).toBe(true);
  });

  it('the same messageId delivered twice has a single effect (inbox)', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const message = wagerMessage(wallet, 'BET', '10.00');
    await send(sqs, queues.queueUrl, message, wallet.id);
    await send(sqs, queues.queueUrl, message, wallet.id);

    const { instance, settled } = consumer();
    while ((await instance.pollOnce()) > 0);

    expect(settled.map((s) => s.action)).toEqual([
      expect.objectContaining({ kind: 'ack', context: expect.objectContaining({ outcome: 'RECORDED' }) }),
      expect.objectContaining({ kind: 'ack', context: expect.objectContaining({ outcome: 'DUPLICATE_MESSAGE' }) }),
    ]);
    expect(await countRows(harness.sql, 'debits', wallet.id)).toBe(1);
  });

  it('a new messageId carrying an already-applied idempotency key is a replay, not a second debit', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const first = wagerMessage(wallet, 'BET', '10.00');
    const resent = { ...first, messageId: crypto.randomUUID() };
    await send(sqs, queues.queueUrl, first, wallet.id);
    await send(sqs, queues.queueUrl, resent, wallet.id);

    const { instance } = consumer();
    while ((await instance.pollOnce()) > 0);

    expect(await countRows(harness.sql, 'debits', wallet.id)).toBe(1);
    expect(await inboxRows(resent.messageId)).toBe(1);
  });

  it('business rejections are terminal: acked, recorded as REJECTED', async () => {
    const wallet = await openTestWallet(harness, '5.00');
    const message = wagerMessage(wallet, 'BET', '50.00');
    await send(sqs, queues.queueUrl, message, wallet.id);

    const { instance, settled } = consumer();
    await instance.pollOnce();

    expect(settled[0]?.action).toMatchObject({ kind: 'ack', context: { status: 'REJECTED' } });
    const [row] = await harness.sql`
      select status, failure_code from wager_transactions where idempotency_key = ${message.data.idempotencyKey}`;
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  it.each([
    ['malformed JSON', '{"messageId":', 'MALFORMED_JSON'],
    ['unknown message type', { messageId: 'm', type: 'SomethingElse', occurredAt: new Date().toISOString(), data: {} }, 'INVALID_MESSAGE'],
  ])('%s goes straight to the DLQ', async (_, body, reason) => {
    await send(sqs, queues.queueUrl, body, 'poison');

    const { instance, settled } = consumer();
    await instance.pollOnce();

    expect(settled[0]?.action).toMatchObject({ kind: 'dlq', reason });
    const [dead] = await drain(sqs, queues.dlqUrl);
    expect(dead?.Body).toBe(typeof body === 'string' ? body : JSON.stringify(body));
    expect(dead?.MessageAttributes?.failureReason?.StringValue).toBe(reason);
  });

  it('a payload the domain rejects (e.g. three decimals) goes to the DLQ', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    await send(sqs, queues.queueUrl, wagerMessage(wallet, 'BET', '1.001'), wallet.id);

    const { instance, settled } = consumer();
    await instance.pollOnce();

    expect(settled[0]?.action).toMatchObject({ kind: 'dlq', reason: 'INVALID_PAYLOAD' });
    await drain(sqs, queues.dlqUrl);
  });

  it('the same messageId with a different payload goes to the DLQ', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const original = wagerMessage(wallet, 'BET', '10.00');
    const tampered = wagerMessage(wallet, 'BET', '99.00', { messageId: original.messageId });
    await send(sqs, queues.queueUrl, original, wallet.id);
    await send(sqs, queues.queueUrl, tampered, wallet.id);

    const { instance, settled } = consumer();
    while ((await instance.pollOnce()) > 0);

    expect(settled.map((s) => s.action.kind)).toEqual(['ack', 'dlq']);
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('90.00');
    await drain(sqs, queues.dlqUrl);
  });

  it('transient failures are not acked: retried with backoff, then applied exactly once', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const message = wagerMessage(wallet, 'BET', '10.00');
    await send(sqs, queues.queueUrl, message, wallet.id);
    const impatient = new WagerTransactionMessageHandler(
      new SubmitWagerTransaction(new MikroOrmUnitOfWork(harness.orm, { lockTimeoutMs: 200 }), new SystemClock(), new UuidV7Generator()),
      CONSUMER,
    );
    const lock = await holdWalletLock(harness.sql, wallet.id);

    const blocked = consumer({}, impatient);
    try {
      await blocked.instance.pollOnce();
    } finally {
      await lock.release();
    }
    expect(blocked.settled[0]?.action).toMatchObject({ kind: 'retry', reason: 'TRANSIENT_INFRASTRUCTURE' });
    expect(await countRows(harness.sql, 'debits', wallet.id)).toBe(0);
    expect(await inboxRows(message.messageId)).toBe(0); // rolled back together with the operation

    await sleep(1_300); // backoff for the first receive is 1s
    const { instance, settled } = consumer();
    await instance.pollOnce();

    expect(settled[0]?.action.kind).toBe('ack');
    expect(await countRows(harness.sql, 'debits', wallet.id)).toBe(1);
  });

  it('a worker killed after COMMIT but before the ack: redelivery is absorbed by the inbox', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const message = wagerMessage(wallet, 'BET', '30.00');
    await send(sqs, queues.queueUrl, message, wallet.id);

    // "Worker A" receives and commits, then dies: the message is never deleted.
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queues.queueUrl, WaitTimeSeconds: 1, VisibilityTimeout: 1 }),
    );
    expect(Messages).toHaveLength(1);
    expect((await handler.handle(Messages[0]!.Body!)).kind).toBe('ack');
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('70.00');

    // Visibility expires, "worker B" gets the same delivery again.
    await sleep(1_200);
    const { instance, settled } = consumer();
    await instance.pollOnce();

    expect(settled[0]?.action).toMatchObject({ kind: 'ack', context: { outcome: 'DUPLICATE_MESSAGE' } });
    expect(await countRows(harness.sql, 'debits', wallet.id)).toBe(1);
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('70.00');
    expect(await queueIsEmpty(queues.queueUrl)).toBe(true);
  });

  it('after maxReceiveCount failed attempts the redrive policy moves the message to the DLQ', async () => {
    const alwaysTransient: MessageHandler = {
      handle: async () => ({ kind: 'retry', reason: 'TRANSIENT_INFRASTRUCTURE' }),
    };
    await send(sqs, queues.queueUrl, { poison: true }, 'redrive');

    const { instance, settled } = consumer({ retryBaseDelaySeconds: 0 }, alwaysTransient);
    for (let i = 0; i < 5; i++) await instance.pollOnce();

    expect(settled).toHaveLength(3); // maxReceiveCount = 3
    const dead = await drain(sqs, queues.dlqUrl);
    expect(dead.map((m) => m.Body)).toEqual([JSON.stringify({ poison: true })]);
  });

  it('a group running out of visibility time releases its remaining messages instead of racing', async () => {
    const order: string[] = [];
    const slow: MessageHandler = {
      handle: async (body) => {
        const { n } = JSON.parse(body);
        order.push(`start-${n}`);
        if (n === 1) await sleep(1_500); // past half of the 2s visibility window
        order.push(`end-${n}`);
        return { kind: 'ack' };
      },
    };
    await send(sqs, queues.queueUrl, { n: 1 }, 'slow-group');
    await send(sqs, queues.queueUrl, { n: 2 }, 'slow-group');

    const owner = consumer({ visibilityTimeoutSeconds: 2 }, slow);
    await owner.instance.pollOnce();

    // Message 1 was finished and acked; message 2 was released, not started late.
    expect(order).toEqual(['start-1', 'end-1']);
    expect(owner.settled.map((s) => s.action.kind)).toEqual(['ack']);

    const next = consumer({ visibilityTimeoutSeconds: 2 }, slow);
    await next.instance.pollOnce();
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(await queueIsEmpty(queues.queueUrl)).toBe(true);
  });

  it('SIGTERM: in-flight work finishes, unstarted deliveries are released, nothing is lost', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const messages = Array.from({ length: 6 }, () => wagerMessage(wallet, 'BET', '1.00'));
    for (const message of messages) await send(sqs, queues.queueUrl, message, wallet.id);

    let stopping: Promise<void> | undefined;
    const first = consumer({
      onSettled: () => {
        stopping ??= first.instance.stop(); // shutdown arrives right after the first delivery
      },
    });
    first.instance.start();
    while (!stopping) await sleep(20);
    await stopping;

    const appliedBeforeShutdown = await countRows(harness.sql, 'debits', wallet.id);
    expect(appliedBeforeShutdown).toBeGreaterThanOrEqual(1);
    expect(appliedBeforeShutdown).toBeLessThan(6);

    // Released deliveries are immediately available to another instance.
    const { instance } = consumer();
    while ((await instance.pollOnce()) > 0);

    expect(await countRows(harness.sql, 'debits', wallet.id)).toBe(6);
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('94.00');
  });
});
