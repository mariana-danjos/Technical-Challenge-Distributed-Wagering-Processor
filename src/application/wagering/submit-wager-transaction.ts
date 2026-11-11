import type { EventContext } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import {
  settleWagerTransaction,
  type SettlementOutcome,
} from '../../domain/wagering/wager-settlement';
import {
  WagerTransaction,
  WagerTransactionStatus,
  type WagerTransactionKind,
} from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { Uniqueness, UniquenessViolationError } from '../errors';
import { payloadHash } from '../idempotency/payload-hash';
import type { Clock, IdGenerator } from '../ports/system';
import type { Repositories, StoredWagerTransaction, UnitOfWork } from '../ports/unit-of-work';

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  causationId?: string | undefined;
}

export type SubmitWagerTransactionResult =
  | {
      outcome: 'RECORDED';
      transactionId: string;
      status: WagerTransactionStatus;
      balance: MoneyProps;
      failureCode: FailureCode | undefined;
      idempotentReplay: boolean;
    }
  /** Same idempotency key with another payload, or same external id under another key. */
  | { outcome: 'IDEMPOTENCY_CONFLICT'; transactionId: string }
  | { outcome: 'WALLET_NOT_FOUND' };

/**
 * Single entry point for provider transactions (HTTP and SQS).
 *
 * Concurrency: the wallet row is locked (SELECT … FOR UPDATE) before anything is decided, so
 * operations on one wallet are serialized while different wallets proceed in parallel.
 * Idempotency: checked before the lock (fast path) and again under it; a concurrent duplicate
 * that slipped past both (different wallet → different lock) is caught by the database UNIQUE
 * constraints and resolved as replay/conflict in a fresh unit of work.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const transaction = this.toTransaction(command);

    try {
      return await this.unitOfWork.run((repositories) =>
        this.submit(repositories, transaction, command),
      );
    } catch (error) {
      if (
        error instanceof UniquenessViolationError &&
        (error.uniqueness === Uniqueness.WagerIdempotencyKey ||
          error.uniqueness === Uniqueness.WagerExternalId)
      ) {
        const existing = await this.unitOfWork.run((repositories) =>
          this.findExisting(repositories, transaction),
        );
        if (existing) return existing;
      }
      throw error;
    }
  }

  /** Validates the input through the domain factories; throws DomainError on invalid payloads. */
  private toTransaction(command: SubmitWagerTransactionCommand): WagerTransaction {
    const money = Money.from(command.money);
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: payloadHash({
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        playerId: command.playerId,
        walletId: command.walletId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: money.toJSON(),
        referenceExternalTransactionId: command.referenceExternalTransactionId || undefined,
      }),
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      at: this.clock.now(),
    });
  }

  private async submit(
    repositories: Repositories,
    transaction: WagerTransaction,
    command: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> {
    const known = await this.findExisting(repositories, transaction);
    if (known) return known;

    const wallet = await repositories.wallets.lockById(transaction.walletId);
    if (!wallet) return { outcome: 'WALLET_NOT_FOUND' };

    // Under the lock: a duplicate for this wallet may have committed while we waited.
    const committedMeanwhile = await this.findExisting(repositories, transaction);
    if (committedMeanwhile) return committedMeanwhile;

    const { reference, referenceAlreadyReversed } = await this.resolveReference(
      repositories,
      transaction,
    );
    const versionBefore = wallet.version;
    const at = this.clock.now();
    const outcome = settleWagerTransaction({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at,
    });

    // Insert order follows the foreign keys: transaction → wallet/ledger → outbox.
    await repositories.transactions.insert(transaction, wallet.balance);
    if (outcome.status === WagerTransactionStatus.Processed && outcome.entry) {
      await repositories.wallets.update(wallet, versionBefore);
      await repositories.ledger.append(outcome.entry);
    }
    await repositories.outbox.enqueue(this.eventsFor(transaction, wallet, outcome, command, at));

    return recorded(transaction, wallet.balance, false);
  }

  private async findExisting(
    repositories: Repositories,
    transaction: WagerTransaction,
  ): Promise<SubmitWagerTransactionResult | undefined> {
    const duplicates = await repositories.transactions.findDuplicates(transaction);
    const byKey = duplicates.find(
      (stored) => stored.transaction.idempotencyKey === transaction.idempotencyKey,
    );
    if (byKey) {
      return byKey.transaction.matchesPayload(transaction.payloadHash)
        ? replay(byKey)
        : { outcome: 'IDEMPOTENCY_CONFLICT', transactionId: byKey.transaction.id };
    }
    const [byExternalId] = duplicates;
    if (byExternalId) {
      return { outcome: 'IDEMPOTENCY_CONFLICT', transactionId: byExternalId.transaction.id };
    }
    return undefined;
  }

  private async resolveReference(repositories: Repositories, transaction: WagerTransaction) {
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

  private eventsFor(
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: SettlementOutcome,
    command: SubmitWagerTransactionCommand,
    at: Date,
  ): OutboxMessage[] {
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: at,
    });

    switch (outcome.status) {
      case WagerTransactionStatus.Processed: {
        const events = [WagerTransactionProcessed.from(transaction, wallet, context())];
        const balanceChanged = outcome.entry
          ? [WalletBalanceChanged.from(wallet, outcome.entry, context())]
          : [];
        return [...events, ...balanceChanged].map((event) => OutboxMessage.enqueue(event));
      }
      case WagerTransactionStatus.Rejected:
        return [OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, context()))];
      case WagerTransactionStatus.PendingReference:
        return [
          OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, context())),
        ];
    }
  }
}

function recorded(
  transaction: WagerTransaction,
  balance: Money,
  idempotentReplay: boolean,
): SubmitWagerTransactionResult {
  return {
    outcome: 'RECORDED',
    transactionId: transaction.id,
    status: transaction.status,
    balance: balance.toJSON(),
    failureCode: transaction.failureCode,
    idempotentReplay,
  };
}

function replay(stored: StoredWagerTransaction): SubmitWagerTransactionResult {
  if (!stored.observedBalance) {
    throw new Error(`Transaction ${stored.transaction.id} has no observed balance to replay`);
  }
  return recorded(stored.transaction, stored.observedBalance, true);
}
