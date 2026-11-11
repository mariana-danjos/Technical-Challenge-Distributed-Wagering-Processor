import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/app-config';
import { ConfigModule } from './infrastructure/config/config.module';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { resolveCorrelationId } from './interfaces/http/correlation-id';
import { HttpApiModule } from './interfaces/http/http-api.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          genReqId: resolveCorrelationId,
          customProps: (req) => ({ correlationId: req.id }),
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        },
      }),
    }),
    MikroOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createOrmConfig(config),
      driver: PostgreSqlDriver,
    }),
    SqsModule,
    HttpApiModule,
  ],
})
export class AppModule {}
