// Repositories act as data mappers over a transaction-scoped EntityManager: reads bypass the
// identity map (domain objects are the in-memory state) and writes are explicit inserts/updates,
// issued in the order the caller chooses so foreign keys and triggers see a consistent sequence.
import { LockMode, type FindOneOptions, type QueryResult } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type {
  DuplicateLookup,
  InboxRepository,
  LedgerRepository,
  LedgerSnapshot,
  OutboxRepository,
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

  async claimDuePendingReference(now: Date): Promise<StoredWagerTransaction | undefined> {
    // NO KEY UPDATE (not UPDATE): a concurrent insert whose FK points at this row takes KEY SHARE,
    // which must not block on — and deadlock with — the resolver holding this row.
    const [claimed] = await this.em.execute<{ id: string }[]>(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_check_at <= ?
        order by next_reference_check_at
        limit 1
        for no key update skip locked`,
      [now],
    );
    if (!claimed) return undefined;
    const record = await this.em.findOne(WagerTransactionSchema, { id: claimed.id }, DETACHED);
    return record ? this.toStored(record) : undefined;
  }

  async lockPendingReference(transactionId: string): Promise<StoredWagerTransaction | undefined> {
    const [locked] = await this.em.execute<{ id: string }[]>(
      `select id from wager_transactions
        where id = ? and status = 'PENDING_REFERENCE'
        for no key update skip locked`,
      [transactionId],
    );
    if (!locked) return undefined;
    const record = await this.em.findOne(WagerTransactionSchema, { id: locked.id }, DETACHED);
    return record ? this.toStored(record) : undefined;
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

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxSchema,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        ...DETACHED,
        orderBy: { nextAttemptAt: 'asc' },
        limit,
        // FOR UPDATE SKIP LOCKED: concurrent publishers claim disjoint batches.
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return records.map(toOutboxMessage);
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
