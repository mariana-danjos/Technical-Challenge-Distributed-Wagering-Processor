// Repositories act as data mappers over a transaction-scoped EntityManager: reads bypass the
// identity map (domain objects are the in-memory state) and writes are explicit inserts/updates,
// issued in the order the caller chooses so foreign keys and triggers see a consistent sequence.
import { LockMode, type FindOneOptions, type QueryResult } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { FailedTransactionRef } from '../../domain/events/wagering-events';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type {
  DuplicateLookup,
  InboxRepository,
  LedgerRepository,
  LedgerSnapshot,
  OutboxClaim,
  OutboxRepository,
  PendingReferenceClaim,
  StoredWagerTransaction,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/unit-of-work';
import {
  fromInboxMessage,
  fromLedgerEntry,
  fromOutboxMessage,
  fromWagerTransaction,
  fromWallet,
  moneyFromColumn,
  toInboxMessage,
  toOutboxMessage,
  toWagerTransaction,
  toWallet,
} from './mappers';
import {
  InboxSchema,
  LedgerEntrySchema,
  OutboxSchema,
  WagerTransactionSchema,
  WalletSchema,
  type WagerTransactionRecord,
} from './records';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DETACHED = { disableIdentityMap: true } as const satisfies FindOneOptions<object>;

export class StaleWalletVersionError extends Error {
  constructor(walletId: string, expectedVersion: number) {
    super(`Wallet ${walletId} changed under its lock (expected version ${expectedVersion})`);
    this.name = 'StaleWalletVersionError';
  }
}

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    if (!UUID_PATTERN.test(id)) return undefined;
    const record = await this.em.findOne(WalletSchema, { id }, DETACHED);
    return record ? toWallet(record) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    if (!UUID_PATTERN.test(id)) return undefined;
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { ...DETACHED, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? toWallet(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, fromWallet(wallet));
  }

  async update(wallet: Wallet, expectedVersion: number): Promise<void> {
    const { balance, version, updatedAt } = fromWallet(wallet);
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance, version, updatedAt },
    );
    // Cannot happen while the row lock is held; guards against a caller that skipped lockById.
    if (affected !== 1) throw new StaleWalletVersionError(wallet.id, expectedVersion);
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findDuplicates(lookup: DuplicateLookup): Promise<StoredWagerTransaction[]> {
    const records = await this.em.find(
      WagerTransactionSchema,
      {
        $or: [
          { idempotencyKey: lookup.idempotencyKey },
          { providerId: lookup.providerId, externalTransactionId: lookup.externalTransactionId },
        ],
      },
      DETACHED,
    );
    const stored: StoredWagerTransaction[] = [];
    for (const record of records) {
      stored.push(await this.toStored(record)); // one transaction connection: run sequentially
    }
    return stored;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { providerId, externalTransactionId },
      DETACHED,
    );
    return record ? this.toStored(record) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });
    return count > 0;
  }

  async insert(transaction: WagerTransaction, observedBalance: Money): Promise<void> {
    await this.em.insert(WagerTransactionSchema, fromWagerTransaction(transaction, observedBalance));
  }

  async update(transaction: WagerTransaction, observedBalance?: Money): Promise<void> {
    const record = fromWagerTransaction(transaction, observedBalance);
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      {
        status: record.status,
        referenceTransactionId: record.referenceTransactionId,
        failureCode: record.failureCode,
        processedAt: record.processedAt,
        referenceAttempts: record.referenceAttempts,
        nextReferenceCheckAt: record.nextReferenceCheckAt,
        ...(observedBalance && { observedBalance: record.observedBalance }),
      },
    );
    if (affected !== 1) throw new Error(`Wager transaction ${transaction.id} not found for update`);
  }

  async findById(transactionId: string): Promise<StoredWagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { id: transactionId }, DETACHED);
    return record ? this.toStored(record) : undefined;
  }

  async claimDuePendingReference(now: Date): Promise<PendingReferenceClaim | undefined> {
    // NO KEY UPDATE (not UPDATE): a concurrent insert whose FK points at this row takes KEY SHARE,
    // which must not block on — and deadlock with — the resolver holding this row.
    const [claimed] = await this.em.execute<{ id: string; reference_attempts: number }[]>(
      `select id, reference_attempts from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_check_at <= ?
        order by next_reference_check_at
        limit 1
        for no key update skip locked`,
      [now],
    );
    return claimed && { transactionId: claimed.id, referenceAttempts: claimed.reference_attempts };
  }

  async reschedulePendingReference(claim: PendingReferenceClaim, nextCheckAt: Date): Promise<boolean> {
    const result = await this.em.execute<QueryResult>(
      `update wager_transactions
          set reference_attempts = reference_attempts + 1, next_reference_check_at = ?
        where id = ? and status = 'PENDING_REFERENCE' and reference_attempts = ?`,
      [nextCheckAt, claim.transactionId, claim.referenceAttempts],
      'run',
    );
    return result.affectedRows === 1;
  }

  async failPendingReference(
    claim: PendingReferenceClaim,
    failureCode: FailureCode,
  ): Promise<FailedTransactionRef | undefined> {
    const [row] = await this.em.execute<
      {
        id: string;
        provider_id: string;
        external_transaction_id: string;
        wallet_id: string;
        player_id: string;
        kind: string;
      }[]
    >(
      `update wager_transactions
          set status = 'FAILED', failure_code = ?
        where id = ? and status = 'PENDING_REFERENCE' and reference_attempts = ?
        returning id, provider_id, external_transaction_id, wallet_id, player_id, kind`,
      [failureCode, claim.transactionId, claim.referenceAttempts],
    );
    return (
      row && {
        transactionId: row.id,
        providerId: row.provider_id,
        externalTransactionId: row.external_transaction_id,
        walletId: row.wallet_id,
        playerId: row.player_id,
        kind: row.kind,
      }
    );
  }

  async wakePendingReferences(
    providerId: string,
    externalTransactionId: string,
    now: Date,
  ): Promise<number> {
    const result = await this.em.execute<QueryResult>(
      `update wager_transactions set next_reference_check_at = ?
        where id in (
          select id from wager_transactions
           where status = 'PENDING_REFERENCE'
             and provider_id = ? and reference_external_transaction_id = ?
             and next_reference_check_at > ?
           for no key update skip locked)`,
      [now, providerId, externalTransactionId, now],
      'run',
    );
    return result.affectedRows;
  }

  private async toStored(record: WagerTransactionRecord): Promise<StoredWagerTransaction> {
    // Observed balance is stored in the wallet's currency (immutable), which may differ from the
    // transaction's currency for CURRENCY_MISMATCH rejections.
    const wallet = await this.em.findOne(
      WalletSchema,
      { id: record.walletId },
      { ...DETACHED, fields: ['currency'] },
    );
    return {
      transaction: toWagerTransaction(record),
      observedBalance:
        record.observedBalance != null && wallet
          ? moneyFromColumn(record.observedBalance, wallet.currency)
          : undefined,
    };
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, fromLedgerEntry(entry));
  }

  async snapshot(walletId: string): Promise<LedgerSnapshot | undefined> {
    if (!UUID_PATTERN.test(walletId)) return undefined;
    const [row] = await this.em.execute<
      { currency: string; stored: string; calculated: string; entries: number }[]
    >(
      `select w.currency,
              w.balance::text as stored,
              coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(19, 2)::text
                as calculated,
              count(e.id)::int as entries
         from wallets w
         left join wallet_ledger_entries e on e.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (!row) return undefined;
    return {
      storedBalance: moneyFromColumn(row.stored, row.currency),
      calculatedBalance: moneyFromColumn(row.calculated, row.currency),
      entries: row.entries,
    };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxSchema, fromInboxMessage(message));
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxSchema, { consumerName, messageId }, DETACHED);
    return record ? toInboxMessage(record) : undefined;
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxSchema, messages.map(fromOutboxMessage));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxClaim> {
    // 1. Lock a batch of due rows that are not stuck behind an earlier event of their aggregate in
    //    backoff (those could never be published now and would starve every other wallet).
    //    Concurrent publishers get disjoint batches.
    const claimed = await this.em.execute<{ id: string; aggregate_id: string }[]>(
      `select o.id, o.aggregate_id from outbox_messages o
        where o.published_at is null and o.next_attempt_at <= ?
          and not exists (
            select 1 from outbox_messages p
             where p.aggregate_id = o.aggregate_id and p.published_at is null
               and p.sequence < o.sequence and p.next_attempt_at > ?)
        order by o.sequence
        limit ?
        for update of o skip locked`,
      [now, now, limit],
    );
    if (claimed.length === 0) return { locked: 0, publishable: [] };

    // 2. Head of line per aggregate: walk each aggregate's unpublished events in order and keep the
    //    claimed ones until the first that is not ours (held by another publisher, or in backoff).
    const claimedIds = new Set(claimed.map((row) => row.id));
    const aggregates = [...new Set(claimed.map((row) => row.aggregate_id))];
    const pending = await this.em.execute<{ id: string; aggregate_id: string }[]>(
      `select id, aggregate_id from outbox_messages
        where published_at is null and aggregate_id in (?)
        order by aggregate_id, sequence`,
      [aggregates],
    );
    const publishable: string[] = [];
    const blocked = new Set<string>();
    for (const row of pending) {
      if (blocked.has(row.aggregate_id)) continue;
      if (claimedIds.has(row.id)) publishable.push(row.id);
      else blocked.add(row.aggregate_id);
    }
    if (publishable.length === 0) return { locked: claimed.length, publishable: [] };

    const records = await this.em.find(
      OutboxSchema,
      { id: { $in: publishable } },
      { ...DETACHED, orderBy: { sequence: 'asc' } },
    );
    return { locked: claimed.length, publishable: records.map(toOutboxMessage) };
  }

  async update(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxSchema,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        publishedAt: message.publishedAt ?? null,
      },
    );
  }
}
