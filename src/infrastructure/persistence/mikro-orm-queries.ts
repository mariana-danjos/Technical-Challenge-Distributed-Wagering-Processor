import type { MikroORM } from '@mikro-orm/postgresql';
import type {
  LedgerEntryView,
  LedgerPage,
  TransactionView,
  WageringQueries,
} from '../../application/ports/queries';
import { toWalletView, type WalletView } from '../../application/wallets/open-wallet';
import { moneyFromColumn, toWallet } from './mappers';
import {
  LedgerEntrySchema,
  WagerTransactionSchema,
  WalletSchema,
  type LedgerEntryRecord,
  type WagerTransactionRecord,
} from './records';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DETACHED = { disableIdentityMap: true } as const;

export class MikroOrmWageringQueries implements WageringQueries {
  constructor(private readonly orm: MikroORM) {}

  async wallet(walletId: string): Promise<WalletView | undefined> {
    if (!UUID_PATTERN.test(walletId)) return undefined;
    const record = await this.orm.em.fork().findOne(WalletSchema, { id: walletId }, DETACHED);
    return record ? toWalletView(toWallet(record)) : undefined;
  }

  async transaction(transactionId: string): Promise<TransactionView | undefined> {
    if (!UUID_PATTERN.test(transactionId)) return undefined;
    return this.findTransaction({ id: transactionId });
  }

  async transactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView | undefined> {
    return this.findTransaction({ providerId, externalTransactionId });
  }

  async ledger(
    walletId: string,
    page: { afterSequence: string | undefined; limit: number },
  ): Promise<LedgerPage | undefined> {
    if (!UUID_PATTERN.test(walletId)) return undefined;
    const em = this.orm.em.fork();
    const wallet = await em.findOne(WalletSchema, { id: walletId }, { ...DETACHED, fields: ['id'] });
    if (!wallet) return undefined;

    const records = await em.find(
      LedgerEntrySchema,
      {
        walletId,
        ...(page.afterSequence !== undefined && { sequence: { $gt: page.afterSequence } }),
      },
      { ...DETACHED, orderBy: { sequence: 'asc' }, limit: page.limit + 1 },
    );
    return {
      items: records.slice(0, page.limit).map(toLedgerEntryView),
      hasMore: records.length > page.limit,
    };
  }

  private async findTransaction(
    where: Partial<Pick<WagerTransactionRecord, 'id' | 'providerId' | 'externalTransactionId'>>,
  ): Promise<TransactionView | undefined> {
    const em = this.orm.em.fork();
    const record = await em.findOne(WagerTransactionSchema, where, DETACHED);
    if (!record) return undefined;
    const wallet = await em.findOne(
      WalletSchema,
      { id: record.walletId },
      { ...DETACHED, fields: ['currency'] },
    );
    return toTransactionView(record, wallet?.currency);
  }
}

function toTransactionView(
  record: WagerTransactionRecord,
  walletCurrency: string | undefined,
): TransactionView {
  return {
    transactionId: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind,
    money: moneyFromColumn(record.amount, record.currency).toJSON(),
    status: record.status,
    failureCode: record.failureCode ?? null,
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? null,
    referenceTransactionId: record.referenceTransactionId ?? null,
    balance:
      record.observedBalance != null && walletCurrency
        ? moneyFromColumn(record.observedBalance, walletCurrency).toJSON()
        : null,
    createdAt: record.createdAt.toISOString(),
    processedAt: record.processedAt?.toISOString() ?? null,
  };
}

function toLedgerEntryView(record: LedgerEntryRecord): LedgerEntryView {
  const money = (amount: string) => moneyFromColumn(amount, record.currency).toJSON();
  return {
    entryId: record.id,
    transactionId: record.transactionId,
    direction: record.direction,
    money: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    createdAt: record.createdAt.toISOString(),
    sequence: String(record.sequence),
  };
}
