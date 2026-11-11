// Repositories act as data mappers over a transaction-scoped EntityManager: reads bypass the
// identity map (domain objects are the in-memory state) and writes are explicit inserts/updates,
// issued in the order the caller chooses so foreign keys and triggers see a consistent sequence.
import { LockMode, type FindOneOptions } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type {
  DuplicateLookup,
  LedgerRepository,
  LedgerSnapshot,
  OutboxRepository,
  StoredWagerTransaction,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/unit-of-work';
import {
  fromLedgerEntry,
  fromOutboxMessage,
  fromWagerTransaction,
  fromWallet,
  moneyFromColumn,
  toWagerTransaction,
  toWallet,
} from './mappers';
import {
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

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxSchema, messages.map(fromOutboxMessage));
  }
}
