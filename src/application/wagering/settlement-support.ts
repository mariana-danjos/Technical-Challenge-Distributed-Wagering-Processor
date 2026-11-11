import type { EventContext } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { SettlementOutcome } from '../../domain/wagering/wager-settlement';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { Repositories } from '../ports/unit-of-work';

export interface ResolvedReference {
  reference: WagerTransaction | undefined;
  referenceAlreadyReversed: boolean;
}

/** Looks up the referenced transaction (same provider) and whether it was already reversed. */
export async function resolveReference(
  repositories: Repositories,
  transaction: WagerTransaction,
): Promise<ResolvedReference> {
  if (!transaction.referenceExternalTransactionId) {
    return { reference: undefined, referenceAlreadyReversed: false };
  }
  const stored = await repositories.transactions.findByExternalId(
    transaction.providerId,
    transaction.referenceExternalTransactionId,
  );
  const reference = stored?.transaction;
  const referenceAlreadyReversed =
    reference !== undefined && transaction.requiresReference()
      ? await repositories.transactions.hasProcessedReversal(reference.id)
      : false;
  return { reference, referenceAlreadyReversed };
}

/**
 * A newly PROCESSED transaction may be the missing reference of parked transactions: make them due
 * now instead of waiting for their backoff.
 */
export async function wakeDependents(
  repositories: Repositories,
  transaction: WagerTransaction,
  now: Date,
): Promise<void> {
  if (transaction.status === WagerTransactionStatus.Processed) {
    await repositories.transactions.wakePendingReferences(
      transaction.providerId,
      transaction.externalTransactionId,
      now,
    );
  }
}

/** Outbox messages for a settlement outcome, written in the same SQL transaction as the outcome. */
export function settlementEvents(
  transaction: WagerTransaction,
  wallet: Wallet,
  outcome: SettlementOutcome,
  context: () => EventContext,
): OutboxMessage[] {
  switch (outcome.status) {
    case WagerTransactionStatus.Processed: {
      const processed = WagerTransactionProcessed.from(transaction, wallet, context());
      const balanceChanged = outcome.entry
        ? [WalletBalanceChanged.from(wallet, outcome.entry, context())]
        : [];
      return [processed, ...balanceChanged].map((event) => OutboxMessage.enqueue(event));
    }
    case WagerTransactionStatus.Rejected:
      return [OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, context()))];
    case WagerTransactionStatus.PendingReference:
      return [OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, context()))];
  }
}
