import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { exponentialBackoffDelay } from '../../domain/shared/backoff';

/** What to do with a delivery once the handler is done. */
export type MessageAction =
  | { kind: 'ack'; context?: Record<string, unknown> }
  | { kind: 'retry'; reason: string; context?: Record<string, unknown> }
  | { kind: 'dlq'; reason: string; context?: Record<string, unknown> };

export interface MessageHandler {
  /** Must not throw for expected failures; unexpected throws are treated as retryable. */
  handle(body: string): Promise<MessageAction>;
}

export interface SqsQueueConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  /** Long-poll wait (max 20). */
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  maxMessages: number;
  retryBaseDelaySeconds: number;
  retryMaxDelaySeconds: number;
  /** Test/observability hook, called after each delivery is settled. */
  onSettled?: (messageId: string, action: MessageAction) => void;
}

export const DEFAULT_CONSUMER_OPTIONS = {
  waitTimeSeconds: 20,
  visibilityTimeoutSeconds: 30,
  maxMessages: 10,
  retryBaseDelaySeconds: 2,
  retryMaxDelaySeconds: 300,
} satisfies Partial<SqsQueueConsumerOptions>;

/**
 * Long-polling SQS consumer.
 * - ack (DeleteMessage) only after the handler returns, i.e. after the business transaction
 *   committed; a crash before that makes SQS redeliver and the inbox absorbs the duplicate;
 * - retry: the message stays, its visibility is extended with exponential backoff by receive count;
 *   after maxReceiveCount (30 → ~2h of retries) the queue's redrive policy moves it to the DLQ;
 * - dlq: permanent failure, forwarded to the DLQ immediately and deleted;
 * - FIFO order: messages of one group run sequentially, groups in parallel; when a message is not
 *   acked, or the batch is running out of visibility time, the rest of its group is released so
 *   ordering is preserved;
 * - stop(): no new receives (the long poll is aborted), in-flight deliveries finish, and
 *   not-yet-started ones get their visibility reset to 0 so another consumer takes them now.
 */
export class SqsQueueConsumer {
  private readonly logger = new Logger(SqsQueueConsumer.name);
  private readonly options: SqsQueueConsumerOptions;
  private running = false;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private abort = new AbortController();

  constructor(
    private readonly sqs: SQSClient,
    private readonly handler: MessageHandler,
    options: Partial<SqsQueueConsumerOptions> & Pick<SqsQueueConsumerOptions, 'queueUrl' | 'dlqUrl'>,
  ) {
    this.options = { ...DEFAULT_CONSUMER_OPTIONS, ...options };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.abort.abort();
    await this.loop;
  }

  /** Receives and settles one batch. Returns the number of deliveries received. */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: this.options.maxMessages,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: signal },
    );
    // Visibility starts at delivery, i.e. when the long poll returns — not when it started.
    const receivedAt = Date.now();
    const messages = response.Messages ?? [];
    if (messages.length === 0) return 0;

    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group, receivedAt)));
    return messages.length;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce(this.abort.signal);
      } catch (error) {
        if (!this.running) break;
        this.logger.error({ err: error }, 'SQS poll failed; backing off');
        await sleep(1_000);
      }
    }
  }

  /**
   * Processes one FIFO group in order. A group is sequential and could outlive the visibility
   * timeout, letting another instance receive its later messages while earlier ones are still
   * running. So a message is only *started* while less than half of the visibility window has
   * elapsed since the receive; the rest of the group is released for a fresh receive. (A
   * ChangeMessageVisibility heartbeat would also work on AWS, but LocalStack rejects the original
   * receipt handle on DeleteMessage once the initial window passes, even when extended.)
   * If a single message overruns the window, its redelivery to another instance blocks on the
   * inbox primary key until this one commits, then resolves as DUPLICATE_MESSAGE — order holds.
   */
  private async processGroup(messages: Message[], receivedAt: number): Promise<void> {
    const startDeadline = receivedAt + (this.options.visibilityTimeoutSeconds * 1_000) / 2;
    for (let i = 0; i < messages.length; i++) {
      if (this.stopping || (i > 0 && Date.now() > startDeadline)) {
        await this.release(messages.slice(i));
        return;
      }
      const action = await this.process(messages[i]!);
      if (action.kind === 'retry') {
        await this.release(messages.slice(i + 1));
        return;
      }
    }
  }

  /** Handles one delivery and applies the resulting action. */
  async process(message: Message): Promise<MessageAction> {
    let action: MessageAction;
    try {
      action = await this.handler.handle(message.Body ?? '');
    } catch (error) {
      this.logger.error({ err: error, messageId: message.MessageId }, 'Unexpected handler failure');
      action = { kind: 'retry', reason: 'UNEXPECTED_ERROR' };
    }

    const log = { messageId: message.MessageId, action: action.kind, ...action.context };
    switch (action.kind) {
      case 'ack':
        await this.delete(message);
        this.logger.log(log, 'Message processed');
        break;
      case 'retry': {
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
        // Same doubling policy as elsewhere, in seconds here.
        const delay = exponentialBackoffDelay(receiveCount, {
          baseDelayMs: this.options.retryBaseDelaySeconds,
          maxDelayMs: this.options.retryMaxDelaySeconds,
        });
        await this.changeVisibility(message, delay);
        this.logger.warn({ ...log, reason: action.reason, receiveCount, retryInSeconds: delay }, 'Message will be retried');
        break;
      }
      case 'dlq':
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.options.dlqUrl,
            MessageBody: message.Body ?? '',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'poison',
            MessageDeduplicationId: message.MessageId,
            MessageAttributes: { failureReason: { DataType: 'String', StringValue: action.reason } },
          }),
        );
        await this.delete(message);
        this.logger.error({ ...log, reason: action.reason }, 'Message moved to DLQ');
        break;
    }
    this.options.onSettled?.(message.MessageId ?? '', action);
    return action;
  }

  private async release(messages: Message[]): Promise<void> {
    await Promise.all(messages.map((message) => this.changeVisibility(message, 0)));
  }

  private async delete(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
