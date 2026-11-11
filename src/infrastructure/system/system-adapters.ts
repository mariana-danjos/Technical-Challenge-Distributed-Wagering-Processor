import { Logger } from '@nestjs/common';
import type { Clock, IdGenerator, Telemetry, WalletDivergence } from '../../application/ports/system';

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
}
