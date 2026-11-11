export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const TELEMETRY = Symbol('TELEMETRY');

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Time-ordered UUID (v7). */
  next(): string;
}

export interface WalletDivergence {
  walletId: string;
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  checkedEntries: number;
}

export interface PendingReferenceFailure {
  transactionId: string;
  /** RESCHEDULED: retried later with backoff; FAILED: retry budget spent, marked FAILED. */
  outcome: 'RESCHEDULED' | 'FAILED';
  attempts: number;
  error: unknown;
}

/** Operational signals the application emits; implemented with logs/metrics in infrastructure. */
export interface Telemetry {
  walletDivergenceDetected(divergence: WalletDivergence): void;
  pendingReferenceResolutionFailed(failure: PendingReferenceFailure): void;
}
