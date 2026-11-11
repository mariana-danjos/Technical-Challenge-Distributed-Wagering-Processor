import { LedgerDirection, type WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { InsufficientFundsError } from '../shared/domain-error';
import type { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { WagerTransactionStatus, type WagerTransaction } from './wager-transaction';

export interface SettlementInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when not found (yet). */
  reference: WagerTransaction | undefined;
  /** Whether the reference already has a PROCESSED REFUND/ROLLBACK. */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  at: Date;
}

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; entry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/**
 * Applies business rules for BET/WIN/LOSS/REFUND/ROLLBACK, mutating both aggregates.
 * The caller must hold the wallet's concurrency guard and persist everything in one SQL transaction.
 */
export function settleWagerTransaction(input: SettlementInput): SettlementOutcome {
  const { transaction, wallet } = input;

  const rejection = checkWallet(transaction, wallet);
  if (rejection) {
    return reject(transaction, rejection);
  }

  let reference: WagerTransaction | undefined;
  if (transaction.hasReference()) {
    const resolved = resolveReference(input);
    if (resolved.kind === 'pending') {
      transaction.markPendingReference(input.at);
      return { status: WagerTransactionStatus.PendingReference };
    }
    if (resolved.kind === 'rejected') {
      return reject(transaction, resolved.failureCode, input.reference?.id);
    }
    reference = resolved.reference;
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, input.at);
    return { status: WagerTransactionStatus.Processed, entry: undefined };
  }

  const direction = transaction.ledgerDirectionFor(reference);
  const movement = {
    transactionId: transaction.id,
    entryId: input.ledgerEntryId,
    money: transaction.money,
    at: input.at,
  };

  let entry: WalletLedgerEntry;
  try {
    entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      const code = transaction.requiresReference()
        ? FailureCode.ReversalInsufficientFunds
        : FailureCode.InsufficientFunds;
      return reject(transaction, code, reference?.id);
    }
    throw error;
  }

  transaction.markProcessed(reference?.id, input.at);
  return { status: WagerTransactionStatus.Processed, entry };
}

function checkWallet(transaction: WagerTransaction, wallet: Wallet): FailureCode | undefined {
  if (transaction.walletId !== wallet.id || transaction.playerId !== wallet.playerId) {
    return FailureCode.WalletPlayerMismatch;
  }
  if (transaction.money.currency !== wallet.currency) {
    return FailureCode.CurrencyMismatch;
  }
  return undefined;
}

type ReferenceResolution =
  | { kind: 'resolved'; reference: WagerTransaction }
  | { kind: 'pending' }
  | { kind: 'rejected'; failureCode: FailureCode };

function resolveReference(input: SettlementInput): ReferenceResolution {
  const { transaction, reference } = input;

  if (!reference) {
    return { kind: 'pending' };
  }
  if (
    reference.providerId !== transaction.providerId ||
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.money.currency !== transaction.money.currency ||
    reference.roundId !== transaction.roundId
  ) {
    return { kind: 'rejected', failureCode: FailureCode.ReferenceMismatch };
  }
  if (!transaction.canReference(reference.kind)) {
    return { kind: 'rejected', failureCode: FailureCode.ReferenceKindNotAllowed };
  }
  if (!reference.isTerminal()) {
    // Reference exists but is itself still pending; it may still be processed.
    return { kind: 'pending' };
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return { kind: 'rejected', failureCode: FailureCode.ReferenceNotProcessed };
  }
  if (transaction.requiresReference()) {
    if (!transaction.money.equals(reference.money)) {
      return { kind: 'rejected', failureCode: FailureCode.AmountMismatch };
    }
    if (input.referenceAlreadyReversed) {
      return { kind: 'rejected', failureCode: FailureCode.ReferenceAlreadyReversed };
    }
  }
  return { kind: 'resolved', reference };
}

function reject(
  transaction: WagerTransaction,
  failureCode: FailureCode,
  referenceTransactionId?: string,
): SettlementOutcome {
  transaction.reject(failureCode, referenceTransactionId);
  return { status: WagerTransactionStatus.Rejected, failureCode };
}
