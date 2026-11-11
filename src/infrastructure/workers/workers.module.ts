import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PublishOutbox } from '../../application/messaging/publish-outbox';
import { CLOCK, TELEMETRY, type Clock, type Telemetry } from '../../application/ports/system';
import { UNIT_OF_WORK, type UnitOfWork } from '../../application/ports/unit-of-work';
import { ResolvePendingReferences } from '../../application/wagering/resolve-pending-references';
import { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import { WagerTransactionMessageHandler } from '../../interfaces/messaging/wager-transaction-message-handler';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SqsEventPublisher } from '../messaging/sqs-event-publisher';
import { SqsQueueConsumer } from '../messaging/sqs-queue-consumer';
import { SqsQueueUrls } from '../messaging/sqs-queue-urls';
import { SQS_CLIENT } from '../messaging/sqs.module';
import { WageringModule } from '../wagering.module';
import { PollingLoop } from './polling-loop';

export const CONSUMER_NAME = 'wager-transactions-consumer';
const OUTBOX_BATCH_SIZE = 10;
const PENDING_REFERENCE_BATCH_SIZE = 20;

/**
 * Runs the SQS consumer, the outbox relay and the pending-reference resolver inside every
 * instance. All three are safe to run on N instances at once (inbox, SKIP LOCKED, wallet locks).
 */
@Injectable()
export class WorkersService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WorkersService.name);
  private consumer: SqsQueueConsumer | undefined;
  private readonly loops: PollingLoop[] = [];
  private starting: Promise<void> | undefined;
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly submitWagerTransaction: SubmitWagerTransaction,
    private readonly resolvePendingReferences: ResolvePendingReferences,
    private readonly publishOutbox: PublishOutbox,
    private readonly queueUrls: SqsQueueUrls,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.workers.enabled) {
      this.logger.log('Workers disabled (WORKERS_ENABLED=false)');
      return;
    }
    this.loops.push(
      new PollingLoop(
        'outbox',
        async () => (await this.publishOutbox.publishBatch()).claimed === OUTBOX_BATCH_SIZE,
        250,
      ),
      new PollingLoop(
        'pending-references',
        async () =>
          (await this.resolvePendingReferences.processDue(PENDING_REFERENCE_BATCH_SIZE)) ===
          PENDING_REFERENCE_BATCH_SIZE,
        1_000,
      ),
    );
    for (const loop of this.loops) loop.start();
    // Queue URLs need SQS; resolve in the background so the HTTP API starts even if SQS is down.
    this.starting = this.startConsumer();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.stopped = true;
    this.logger.log({ signal }, 'Stopping workers');
    await this.starting;
    await Promise.all([this.consumer?.stop(), ...this.loops.map((loop) => loop.stop())]);
    this.logger.log('Workers stopped');
  }

  private async startConsumer(): Promise<void> {
    while (!this.stopped) {
      try {
        const [queueUrl, dlqUrl] = await Promise.all([
          this.queueUrls.resolve(this.config.sqs.wagerQueueName),
          this.queueUrls.resolve(this.config.sqs.wagerDlqName),
        ]);
        if (this.stopped) return;
        this.consumer = new SqsQueueConsumer(
          this.sqs,
          new WagerTransactionMessageHandler(this.submitWagerTransaction, CONSUMER_NAME),
          { queueUrl, dlqUrl },
        );
        this.consumer.start();
        this.logger.log({ queueUrl }, 'SQS consumer started');
        return;
      } catch (error) {
        this.logger.error({ err: error }, 'Cannot resolve SQS queues; retrying');
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }
}

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: SqsQueueUrls,
      inject: [SQS_CLIENT],
      useFactory: (sqs: SQSClient) => new SqsQueueUrls(sqs),
    },
    {
      provide: PublishOutbox,
      inject: [UNIT_OF_WORK, CLOCK, TELEMETRY, SQS_CLIENT, SqsQueueUrls, APP_CONFIG],
      useFactory: (
        uow: UnitOfWork,
        clock: Clock,
        telemetry: Telemetry,
        sqs: SQSClient,
        urls: SqsQueueUrls,
        config: AppConfig,
      ) =>
        new PublishOutbox(
          uow,
          new SqsEventPublisher(sqs, () => urls.resolve(config.sqs.wagerEventsQueueName)),
          clock,
          telemetry,
          OUTBOX_BATCH_SIZE,
        ),
    },
    WorkersService,
  ],
})
export class WorkersModule {}
