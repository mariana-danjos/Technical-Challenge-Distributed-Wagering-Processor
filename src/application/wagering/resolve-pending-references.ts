import { FailureCode } from '../../domain/wagering/failure-code';
import { settleWagerTransaction, type SettlementOutcome } from '../../domain/wagering/wager-settlement';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { TransientInfrastructureError } from '../errors';
import type { Clock, IdGenerator, Telemetry } from '../ports/system';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';
import { resolveReference, settlementEvents, wakeDependents } from './settlement-support';

export type ResolutionResult =
  | { transactionId: string; status: WagerTransactionStatus; failureCode?: FailureCode }
  | undefined;

/**
 * Re-settles PENDING_REFERENCE transactions whose next check is due (§7.1). Each transaction is
 * handled in its own unit of work: claim the row (SKIP LOCKED, so N resolvers share the work), lock
 * its wallet, and settle again. Missing references are rescheduled with backoff until the retry
 * budget is spent, then REJECTED with REFERENCE_NOT_FOUND.
 *
 * Lock order is transaction row → wallet row. The submit path only ever locks wallets and inserts,
 * so the two paths cannot deadlock.
 *
 * Failure isolation: a row that fails for a non-transient reason (bug, constraint, trigger) would
 * otherwise roll back, stay due at the head of the queue and block every other row forever. It is
 * instead rescheduled in a separate unit of work — consuming the same retry budget — and marked
 * FAILED once the budget is spent. A transient failure ends the tick and leaves the row due.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly telemetry: Telemetry,
  ) {}

  /** Resolves up to `limit` due transactions; returns how many were handled. */
  async processDue(limit: number): Promise<number> {
    let handled = 0;
    while (handled < limit) {
      let claimedId: string | undefined;
      try {
        const result = await this.unitOfWork.run((repositories) =>
          this.resolveNext(repositories, (id) => (claimedId = id)),
        );
        if (!result) break;
      } catch (error) {
        if (error instanceof TransientInfrastructureError || claimedId === undefined) throw error;
        await this.quarantine(claimedId, error);
      }
      handled += 1;
    }
    return handled;
  }

  private async resolveNext(
    repositories: Repositories,
    onClaimed: (transactionId: string) => void,
  ): Promise<ResolutionResult> {
    const claimed = await repositories.transactions.claimDuePendingReference(this.clock.now());
    if (!claimed) return undefined;
    const { transaction } = claimed;
    onClaimed(transaction.id);

    const wallet = await repositories.wallets.lockById(transaction.walletId);
    if (!wallet) throw new Error(`Wallet ${transaction.walletId} of ${transaction.id} not found`);
    const versionBefore = wallet.version;
    // Read after the wallet lock: anything committed on this wallet while we waited is older.
    const now = this.clock.now();

    const { reference, referenceAlreadyReversed } = await resolveReference(repositories, transaction);

    let outcome: SettlementOutcome;
    if (!reference && transaction.hasExhaustedReferenceAttempts()) {
      transaction.reject(FailureCode.ReferenceNotFound);
      outcome = { status: WagerTransactionStatus.Rejected, failureCode: FailureCode.ReferenceNotFound };
    } else {
      outcome = settleWagerTransaction({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: this.ids.next(),
        at: now,
      });
    }

    await repositories.transactions.update(transaction, wallet.balance);
    if (outcome.status === WagerTransactionStatus.Processed && outcome.entry) {
      await repositories.wallets.update(wallet, versionBefore);
      await repositories.ledger.append(outcome.entry);
    }
    // Still waiting: the PendingReference event was published when it was first parked.
    if (outcome.status !== WagerTransactionStatus.PendingReference) {
      await repositories.outbox.enqueue(
        settlementEvents(transaction, wallet, outcome, () => ({
          eventId: this.ids.next(),
          correlationId: this.ids.next(),
          causationId: transaction.id,
          occurredAt: now,
        })),
      );
      await wakeDependents(repositories, transaction, now);
    }

    return {
      transactionId: transaction.id,
      status: transaction.status,
      ...(transaction.failureCode && { failureCode: transaction.failureCode }),
    };
  }

  /** Moves a failing row out of the way: reschedule with backoff, or FAILED when out of budget. */
  private async quarantine(transactionId: string, error: unknown): Promise<void> {
    await this.unitOfWork.run(async (repositories) => {
      const locked = await repositories.transactions.lockPendingReference(transactionId);
      if (!locked) return; // settled or taken by another resolver meanwhile
      const { transaction } = locked;

      const exhausted = transaction.hasExhaustedReferenceAttempts();
      if (exhausted) {
        transaction.fail(FailureCode.InternalError);
      } else {
        transaction.markPendingReference(this.clock.now());
      }
      await repositories.transactions.update(transaction);

      this.telemetry.pendingReferenceResolutionFailed({
        transactionId,
        outcome: exhausted ? 'FAILED' : 'RESCHEDULED',
        attempts: transaction.referenceAttempts,
        error,
      });
    });
  }
}
