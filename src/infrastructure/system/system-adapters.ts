import { Logger } from '@nestjs/common';
import type {
  Clock,
  IdGenerator,
  OutboxPublishFailure,
  PendingReferenceFailure,
  Telemetry,
  WalletDivergence,
} from '../../application/ports/system';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

/** Log-based telemetry; the divergence counter becomes a real metric in the observability step. */
export class LoggingTelemetry implements Telemetry {
  private readonly logger = new Logger('Telemetry');
  private divergences = 0;

  walletDivergenceDetected(divergence: WalletDivergence): void {
    this.divergences += 1;
    this.logger.error({ ...divergence, divergencesDetected: this.divergences }, 'Wallet balance diverges from ledger');
  }

  pendingReferenceResolutionFailed({ error, ...failure }: PendingReferenceFailure): void {
    this.logger.error({ ...failure, err: error }, 'Pending reference could not be resolved');
  }

  outboxPublishFailed({ error, messageIds }: OutboxPublishFailure): void {
    this.logger.error({ err: error, messageIds, count: messageIds.length }, 'Outbox publish failed');
  }
}
