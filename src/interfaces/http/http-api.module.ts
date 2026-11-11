import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { WageringModule } from '../../infrastructure/wagering.module';
import { AllowAllAuthenticator, AuthGuard, REQUEST_AUTHENTICATOR } from './auth/auth';
import { ApiExceptionFilter } from './errors/api-exception.filter';
import { HealthController } from './health/health.controller';
import { WageringController } from './wagering.controller';
import { WalletsController } from './wallets.controller';

@Module({
  imports: [WageringModule],
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    { provide: REQUEST_AUTHENTICATOR, useClass: AllowAllAuthenticator },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class HttpApiModule {}
