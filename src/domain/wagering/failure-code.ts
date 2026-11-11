/**
 * Stable, machine-readable reasons for REJECTED (business) and FAILED (infrastructure) transactions.
 * Values are persisted and exposed to providers — never rename, only add.
 */
export enum FailureCode {
  /** BET larger than the available balance. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** REFUND/ROLLBACK whose debit would make the balance negative. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** walletId does not belong to playerId. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Reference still missing after the retry budget was exhausted. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Reference belongs to another player, wallet, currency or round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** e.g. REFUND referencing a WIN. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Reference ended REJECTED or FAILED. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** REFUND/ROLLBACK amount differs from the reference amount. */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** Permanent infrastructure failure (FAILED status). */
  InternalError = 'INTERNAL_ERROR',
}
