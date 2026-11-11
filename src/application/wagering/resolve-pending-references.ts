import { WagerTransactionFailed } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/wagering/failure-code';
import { settleWagerTransaction, type SettlementOutcome } from '../../domain/wagering/wager-settlement';
import {
  REFERENCE_RETRY_POLICY,
  WagerTransactionStatus,
  nextReferenceCheckAt,
} from '../../domain/wagering/wager-transaction';
import { TransientInfrastructureError } from '../errors';
import type { Clock, IdGenerator, PendingReferenceFailure, Telemetry } from '../ports/system';
import type { PendingReferenceClaim, Repositories, UnitOfWork } from '../ports/unit-of-work';
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
 * Failure isolation: a row that fails for a non-transient reason (bug, unreadable data, constraint,
 * trigger) would otherwise roll back, stay due at the head of the queue and block every other row
 * forever. Its id and attempt count are captured right after the claim — before loading — and it
 * is quarantined in a separate unit of work with plain compare-and-set SQL (no rehydration):
 * rescheduled with backoff on the same budget, with one grace attempt beyond it, then FAILED with
 * a WagerTransactionFailed event. A transient failure ends the tick and leaves the row due.
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
      const claimed: { value?: PendingReferenceClaim } = {};
      try {
        const result = await this.unitOfWork.run((repositories) =>
          this.resolveNext(repositories, (claim) => (claimed.value = claim)),
        );
        if (!result) break;
      } catch (error) {
        if (error instanceof TransientInfrastructureError || !claimed.value) throw error;
        const failure = await this.quarantine(claimed.value, error);
        // After COMMIT, so the signal never reports something that was rolled back.
        if (failure) this.telemetry.pendingReferenceResolutionFailed(failure);
      }
      handled += 1;
    }
    return handled;
  }

  private async resolveNext(
    repositories: Repositories,
    onClaimed: (claim: PendingReferenceClaim) => void,
  ): Promise<ResolutionResult> {
    const claim = await repositories.transactions.claimDuePendingReference(this.clock.now());
    if (!claim) return undefined;
    onClaimed(claim);

    const stored = await repositories.transactions.findById(claim.transactionId);
    if (!stored) throw new Error(`Claimed transaction ${claim.transactionId} disappeared`);
    const { transaction } = stored;

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

  /**
   * Moves a failing row out of the way. Compare-and-set on the claimed attempt count: if another
   * resolver already advanced the row meanwhile, nothing is done (no double-spent budget).
   */
  private async quarantine(
    claim: PendingReferenceClaim,
    error: unknown,
  ): Promise<PendingReferenceFailure | undefined> {
    const now = this.clock.now();
    // One grace attempt past the budget: a row woken on its last attempt is not failed by a single
    // sporadic error.
    const exhausted = claim.referenceAttempts > REFERENCE_RETRY_POLICY.maxAttempts;

    return this.unitOfWork.run(async (repositories) => {
      if (!exhausted) {
        const attempts = claim.referenceAttempts + 1;
        const rescheduled = await repositories.transactions.reschedulePendingReference(
          claim,
          nextReferenceCheckAt(attempts, now),
        );
        return rescheduled
          ? { transactionId: claim.transactionId, outcome: 'RESCHEDULED' as const, attempts, error }
          : undefined;
      }

      const failed = await repositories.transactions.failPendingReference(claim, FailureCode.InternalError);
      if (!failed) return undefined;
      // Outbox sequence is only commit-ordered per wallet if every insert holds the wallet lock.
      // Order stays transaction row → wallet, as in resolveNext.
      await repositories.wallets.lockById(failed.walletId);
      await repositories.outbox.enqueue([
        OutboxMessage.enqueue(
          WagerTransactionFailed.from(failed, FailureCode.InternalError, {
            eventId: this.ids.next(),
            correlationId: this.ids.next(),
            causationId: claim.transactionId,
            occurredAt: now,
          }),
        ),
      ]);
      return {
        transactionId: claim.transactionId,
        outcome: 'FAILED' as const,
        attempts: claim.referenceAttempts,
        error,
      };
    });
  }
}
