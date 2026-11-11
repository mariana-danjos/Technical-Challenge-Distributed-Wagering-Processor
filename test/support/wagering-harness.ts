import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import type {
  PendingReferenceFailure,
  Telemetry,
  WalletDivergence,
} from '../../src/application/ports/system';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../src/application/wagering/submit-wager-transaction';
import { OpenWallet, type WalletView } from '../../src/application/wallets/open-wallet';
import { ReconcileWallet } from '../../src/application/wallets/reconcile-wallet';
import {
  MikroOrmUnitOfWork,
  type UnitOfWorkOptions,
} from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system/system-adapters';
import { setUpTestDatabase } from './test-database';

export class RecordingTelemetry implements Telemetry {
  readonly divergences: WalletDivergence[] = [];
  readonly pendingReferenceFailures: PendingReferenceFailure[] = [];

  walletDivergenceDetected(divergence: WalletDivergence): void {
    this.divergences.push(divergence);
  }

  pendingReferenceResolutionFailed(failure: PendingReferenceFailure): void {
    this.pendingReferenceFailures.push(failure);
  }
}

export interface WageringHarness {
  orm: MikroORM;
  sql: SQL;
  telemetry: RecordingTelemetry;
  openWallet: OpenWallet;
  submit: SubmitWagerTransaction;
  reconcile: ReconcileWallet;
  /** Use cases over a unit of work with custom options (e.g. a short lock timeout). */
  withOptions(options: Partial<UnitOfWorkOptions>): { submit: SubmitWagerTransaction };
  close(): Promise<void>;
}

/** Real use cases over the real `wagering_test` PostgreSQL database — no mocks. */
export async function createWageringHarness(): Promise<WageringHarness> {
  const { orm, sql } = await setUpTestDatabase();
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  const telemetry = new RecordingTelemetry();
  const unitOfWork = new MikroOrmUnitOfWork(orm);

  return {
    orm,
    sql,
    telemetry,
    openWallet: new OpenWallet(unitOfWork, clock, ids),
    submit: new SubmitWagerTransaction(unitOfWork, clock, ids),
    reconcile: new ReconcileWallet(unitOfWork, telemetry),
    withOptions: (options) => ({
      submit: new SubmitWagerTransaction(new MikroOrmUnitOfWork(orm, options), clock, ids),
    }),
    close: async () => {
      await sql.close();
      await orm.close();
    },
  };
}

export async function openTestWallet(harness: WageringHarness, amount: string, currency = 'BRL') {
  const result = await harness.openWallet.execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency },
    correlationId: crypto.randomUUID(),
  });
  if (result.outcome !== 'OPENED') throw new Error('wallet was not opened');
  return result.wallet;
}

/** A provider command for `wallet`; unique external id unless overridden. */
export function wagerCommand(
  wallet: WalletView,
  kind: string,
  amount: string,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const providerId = overrides.providerId ?? 'provider-a';
  const externalTransactionId = overrides.externalTransactionId ?? crypto.randomUUID();
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: wallet.balance.currency },
    correlationId: crypto.randomUUID(),
    ...overrides,
  };
}

/** Global invariant of every test: wallet.balance == balance rebuilt from the ledger. */
export async function expectLedgerConsistent(sql: SQL, walletId: string): Promise<string> {
  const [row] = await sql`
    select w.balance::text as stored,
           coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(19, 2)::text
             as calculated
      from wallets w
      left join wallet_ledger_entries e on e.wallet_id = w.id
     where w.id = ${walletId}
     group by w.id`;
  expect(row).toBeDefined();
  expect(row.calculated).toBe(row.stored);
  return row.stored as string;
}

export async function countRows(sql: SQL, query: 'entries' | 'debits', walletId: string) {
  const [row] =
    query === 'entries'
      ? await sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId}`
      : await sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  return row.n as number;
}

export async function outboxEventTypes(sql: SQL, walletId: string): Promise<string[]> {
  const rows = await sql`
    select event_type from outbox_messages where aggregate_id = ${walletId} order by occurred_at, event_type`;
  return rows.map((row: { event_type: string }) => row.event_type);
}

/** Holds `walletId`'s row lock in a separate connection until `release()` is called. */
export async function holdWalletLock(sql: SQL, walletId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const acquired = new Promise<void>((resolve) => (locked = resolve));

  const transaction = sql.begin(async (tx) => {
    await tx`select id from wallets where id = ${walletId} for update`;
    locked();
    await released;
  });
  await acquired;
  return {
    release: async () => {
      release();
      await transaction;
    },
  };
}
