import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../infrastructure/config/app-config';
import { SQS_CLIENT } from '../../../infrastructure/messaging/sqs.module';
import { Public } from '../auth/auth';

type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2_000;

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  async ready(): Promise<{ status: 'ok'; checks: Record<string, CheckStatus> }> {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.orm.em.fork().getConnection().execute('select 1')),
      this.check(() =>
        this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerQueueName })),
      ),
    ]);
    const checks = { postgres, sqs };

    if (postgres === 'down' || sqs === 'down') {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
    return { status: 'ok', checks };
  }

  private async check(probe: () => Promise<unknown>): Promise<CheckStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([probe(), timeout]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
