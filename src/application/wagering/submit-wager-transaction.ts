import { InboxMessage } from '../../domain/messaging/inbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import { settleWagerTransaction } from '../../domain/wagering/wager-settlement';
import {
  WagerTransaction,
  WagerTransactionStatus,
  type WagerTransactionKind,
} from '../../domain/wagering/wager-transaction';
import { Uniqueness, UniquenessViolationError } from '../errors';
import { payloadHash } from '../idempotency/payload-hash';
import type { Clock, IdGenerator } from '../ports/system';
import type { Repositories, StoredWagerTransaction, UnitOfWork } from '../ports/unit-of-work';
import { resolveReference, settlementEvents, wakeDependents } from './settlement-support';

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

/** Queue delivery being processed; recorded in the inbox inside the same SQL transaction. */
export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  payloadHash: string;
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
  | { outcome: 'WALLET_NOT_FOUND' }
  /** Inbox: this message was already processed (redelivery). Nothing was done. */
  | { outcome: 'DUPLICATE_MESSAGE' }
  /** Inbox: same message id seen before with a different payload. */
  | { outcome: 'MESSAGE_PAYLOAD_CONFLICT' };

/**
 * Single entry point for provider transactions (HTTP and SQS).
 *
 * Concurrency: the wallet row is locked (SELECT … FOR UPDATE) before anything is decided, so
 * operations on one wallet are serialized while different wallets proceed in parallel.
 * Idempotency: checked before the lock (fast path) and again under it; a concurrent duplicate
 * that slipped past both (different wallet → different lock) is caught by the database UNIQUE
 * constraints and resolved as replay/conflict in a fresh unit of work.
 * Inbox (SQS): the inbox row is the first write of the unit of work, so a redelivered message
 * either finds it committed together with the financial effect, or finds nothing at all.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    command: SubmitWagerTransactionCommand,
    options: { inbox?: InboxReceipt } = {},
  ): Promise<SubmitWagerTransactionResult> {
    const transaction = this.toTransaction(command);

    try {
      return await this.unitOfWork.run((repositories) =>
        this.submit(repositories, transaction, command, options.inbox),
      );
    } catch (error) {
      if (!(error instanceof UniquenessViolationError)) throw error;

      if (error.uniqueness === Uniqueness.InboxMessage && options.inbox) {
        const outcome = await this.inboxOutcome(options.inbox);
        if (outcome) return outcome;
      }
      if (
        error.uniqueness === Uniqueness.WagerIdempotencyKey ||
        error.uniqueness === Uniqueness.WagerExternalId
      ) {
        return this.resolveDuplicateRace(transaction, options.inbox, error);
      }
      throw error;
    }
  }

  /**
   * A concurrent duplicate committed first and the UNIQUE constraint rolled us back (inbox row
   * included). Answer replay/conflict in a fresh unit of work, recording the inbox receipt there so
   * a later redelivery is recognized. The receipt must never commit without the duplicate being
   * found, or that redelivery would be acked with no effect.
   */
  private async resolveDuplicateRace(
    transaction: WagerTransaction,
    inbox: InboxReceipt | undefined,
    cause: UniquenessViolationError,
  ): Promise<SubmitWagerTransactionResult> {
    try {
      return await this.unitOfWork.run(async (repositories) => {
        if (inbox) await this.recordInbox(repositories, inbox);
        const existing = await this.findExisting(repositories, transaction);
        if (!existing) throw cause;
        return existing;
      });
    } catch (error) {
      if (inbox && error instanceof UniquenessViolationError && error.uniqueness === Uniqueness.InboxMessage) {
        const outcome = await this.inboxOutcome(inbox);
        if (outcome) return outcome;
      }
      throw error;
    }
  }

  private async inboxOutcome(receipt: InboxReceipt): Promise<SubmitWagerTransactionResult | undefined> {
    const seen = await this.unitOfWork.run((repositories) =>
      repositories.inbox.find(receipt.consumerName, receipt.messageId),
    );
    if (!seen) return undefined;
    return seen.payloadHash === receipt.payloadHash
      ? { outcome: 'DUPLICATE_MESSAGE' }
      : { outcome: 'MESSAGE_PAYLOAD_CONFLICT' };
  }

  private async recordInbox(repositories: Repositories, receipt: InboxReceipt): Promise<void> {
    const message = InboxMessage.receive({ ...receipt, receivedAt: this.clock.now() });
    message.markProcessed(message.receivedAt);
    await repositories.inbox.insert(message);
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
    inbox: InboxReceipt | undefined,
  ): Promise<SubmitWagerTransactionResult> {
    // A duplicate delivery fails here on the primary key and rolls back everything.
    if (inbox) await this.recordInbox(repositories, inbox);

    const known = await this.findExisting(repositories, transaction);
    if (known) return known;

    const wallet = await repositories.wallets.lockById(transaction.walletId);
    if (!wallet) return { outcome: 'WALLET_NOT_FOUND' };

    // Under the lock: a duplicate for this wallet may have committed while we waited.
    const committedMeanwhile = await this.findExisting(repositories, transaction);
    if (committedMeanwhile) return committedMeanwhile;

    const { reference, referenceAlreadyReversed } = await resolveReference(repositories, transaction);
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
    await repositories.outbox.enqueue(
      settlementEvents(transaction, wallet, outcome, () => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        causationId: command.causationId,
        occurredAt: at,
      })),
    );
    await wakeDependents(repositories, transaction, at);

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
