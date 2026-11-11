// All events use the walletId as aggregateId: the wallet is the unit of ordering and concurrency.
import type { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../wagering/failure-code';
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wagering/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import { IntegrationEvent, type EventContext } from './integration-event';

interface WagerTransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionRef(transaction: WagerTransaction): WagerTransactionRef {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

export interface WagerTransactionProcessedData extends WagerTransactionRef {
  status: WagerTransactionStatus.Processed;
  referenceTransactionId: string | null;
  balance: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...transactionRef(transaction),
        status: transaction.status as WagerTransactionStatus.Processed,
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionRef {
  failureCode: FailureCode;
  referenceExternalTransactionId: string | null;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (transaction.failureCode === undefined) {
      throw new Error(`Transaction ${transaction.id} has no failure code`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...transactionRef(transaction),
        failureCode: transaction.failureCode,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionRef {
  referenceExternalTransactionId: string;
  attempts: number;
  nextCheckAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (!transaction.referenceExternalTransactionId || !transaction.nextReferenceCheckAt) {
      throw new Error(`Transaction ${transaction.id} is not waiting for a reference`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...transactionRef(transaction),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        attempts: transaction.referenceAttempts,
        nextCheckAt: transaction.nextReferenceCheckAt.toISOString(),
      },
    });
  }
}

/** Identifiers of a transaction, readable straight from storage without rehydrating it. */
export interface FailedTransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: string;
}

export interface WagerTransactionFailedData extends FailedTransactionRef {
  failureCode: FailureCode;
}

/**
 * Terminal infrastructure failure (status FAILED). Built from stored identifiers only, because the
 * transaction may have failed precisely because it cannot be rehydrated.
 */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(ref: FailedTransactionRef, failureCode: FailureCode, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed({
      ...ctx,
      aggregateId: ref.walletId,
      data: { ...ref, failureCode },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
