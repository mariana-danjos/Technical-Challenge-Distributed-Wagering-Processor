import { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SQSClient({
          region: config.aws.region,
          endpoint: config.aws.endpoint,
          // Bounded calls: the outbox publishes inside an open SQL transaction, and shutdown waits
          // for in-flight work. requestTimeout must exceed the consumer's long-poll wait (10s).
          requestHandler: { connectionTimeout: 3_000, requestTimeout: 15_000 },
        }),
    },
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
