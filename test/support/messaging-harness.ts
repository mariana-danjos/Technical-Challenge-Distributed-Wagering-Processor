import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { WalletView } from '../../src/application/wallets/open-wallet';

/** SQS client for the docker-compose LocalStack (real SQS API, no mocks). */
export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  });
}

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  delete(): Promise<void>;
}

/** Fresh FIFO queues per test file: main (with redrive to DLQ), DLQ and events. */
export async function createTestQueues(sqs: SQSClient, maxReceiveCount = 3): Promise<TestQueues> {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}`;
  const create = async (name: string, attributes: Record<string, string> = {}) => {
    const response = await sqs.send(
      new CreateQueueCommand({ QueueName: `${prefix}-${name}.fifo`, Attributes: { FifoQueue: 'true', ...attributes } }),
    );
    return response.QueueUrl!;
  };

  const dlqUrl = await create('wager-transactions-dlq');
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const queueUrl = await create('wager-transactions', {
    VisibilityTimeout: '30',
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: Attributes!.QueueArn,
      maxReceiveCount: String(maxReceiveCount),
    }),
  });
  const eventsUrl = await create('wager-events');

  return {
    queueUrl,
    dlqUrl,
    eventsUrl,
    delete: async () => {
      for (const url of [queueUrl, dlqUrl, eventsUrl]) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
      }
    },
  };
}

/** A §10 `WagerTransactionRequested` envelope for `wallet`. */
export function wagerMessage(
  wallet: WalletView,
  kind: string,
  amount: string,
  overrides: { messageId?: string; data?: Record<string, unknown> } = {},
) {
  const externalTransactionId = crypto.randomUUID();
  return {
    messageId: overrides.messageId ?? crypto.randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: wallet.balance.currency },
      ...overrides.data,
    },
  };
}

/** Sends a raw body; each send is a distinct SQS delivery even for the same envelope. */
export async function send(sqs: SQSClient, queueUrl: string, body: unknown, groupId: string) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}

/** Receives and deletes until the queue looks empty. */
export async function drain(sqs: SQSClient, queueUrl: string): Promise<Message[]> {
  const received: Message[] = [];
  for (let emptyPolls = 0; emptyPolls < 2; ) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60,
        MessageAttributeNames: ['All'],
      }),
    );
    if (Messages.length === 0) {
      emptyPolls += 1;
      continue;
    }
    for (const message of Messages) {
      received.push(message);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return received;
}

export async function waitFor(condition: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
