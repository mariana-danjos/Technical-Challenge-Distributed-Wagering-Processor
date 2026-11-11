/** Retryable infrastructure failure: lock timeout, deadlock, lost connection, pool exhaustion. */
export class TransientInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}

export enum Uniqueness {
  WalletPlayerCurrency = 'WALLET_PLAYER_CURRENCY',
  WagerIdempotencyKey = 'WAGER_IDEMPOTENCY_KEY',
  WagerExternalId = 'WAGER_EXTERNAL_ID',
  InboxMessage = 'INBOX_MESSAGE',
  Other = 'OTHER',
}

/** A database uniqueness guarantee rejected the write; the unit of work was rolled back. */
export class UniquenessViolationError extends Error {
  constructor(
    readonly uniqueness: Uniqueness,
    options?: { cause?: unknown },
  ) {
    super(`Uniqueness violated: ${uniqueness}`, options);
    this.name = 'UniquenessViolationError';
  }
}
