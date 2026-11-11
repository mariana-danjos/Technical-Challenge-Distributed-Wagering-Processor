// Requires `docker compose up -d postgres`. Exercises the database-level guarantees directly with
// raw SQL, bypassing the domain, to prove the schema enforces them on its own.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import { setUpTestDatabase } from '../support/test-database';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const INTEGRITY_VIOLATION = '23000';

const HASH = 'a'.repeat(64);
const AT = '2026-07-29T15:00:00.000Z';

let orm: MikroORM;
let sql: SQL;

beforeAll(async () => {
  ({ orm, sql } = await setUpTestDatabase());
});

afterAll(async () => {
  await sql?.close();
  await orm?.close();
});

async function expectPgError(operation: Promise<unknown>, errno: string, message?: RegExp) {
  try {
    await operation;
  } catch (error) {
    const pgError = error as { errno?: string; message: string };
    expect(pgError.errno).toBe(errno);
    if (message) expect(pgError.message).toMatch(message);
    return;
  }
  throw new Error(`Expected PostgreSQL error ${errno}, but the statement succeeded`);
}

// ---------------------------------------------------------------- row builders

interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
}

interface TransactionRow {
  id: string;
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  externalId: string;
  referenceExternalId: string | null;
  referenceId: string | null;
  failureCode: string | null;
  processedAt: string | null;
  observedBalance: string | null;
}

function insertWallet(tx: SQL, row: WalletRow, version = 1) {
  return tx`
    insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
    values (${row.id}, ${row.playerId}, ${row.currency}, ${row.balance}, ${version}, ${AT}, ${AT})`;
}

function insertTransaction(tx: SQL, row: TransactionRow) {
  return tx`
    insert into wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
      round_id, game_id, kind, amount, currency, reference_external_transaction_id,
      reference_transaction_id, status, failure_code, next_reference_check_at, created_at, processed_at,
      observed_balance)
    values (
      ${row.id}, 'provider-a', ${row.externalId}, ${`provider-a:${row.externalId}`}, ${HASH},
      ${row.walletId}, ${row.playerId}, 'round-1', 'game-1', ${row.kind}, ${row.amount},
      ${row.currency}, ${row.referenceExternalId}, ${row.referenceId}, ${row.status},
      ${row.failureCode}, ${row.status === 'PENDING_REFERENCE' ? AT : null}, ${AT}, ${row.processedAt},
      ${row.observedBalance})`;
}

function insertEntry(
  tx: SQL,
  entry: {
    walletId: string;
    transactionId: string;
    direction: 'DEBIT' | 'CREDIT';
    amount: string;
    before: string;
    after: string;
    currency?: string;
  },
) {
  return tx`
    insert into wallet_ledger_entries (
      id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after,
      created_at)
    values (
      ${crypto.randomUUID()}, ${entry.walletId}, ${entry.transactionId}, ${entry.direction},
      ${entry.amount}, ${entry.currency ?? 'BRL'}, ${entry.before}, ${entry.after}, ${AT})`;
}

function transaction(overrides: Partial<TransactionRow> & Pick<TransactionRow, 'walletId' | 'playerId'>): TransactionRow {
  return {
    id: crypto.randomUUID(),
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PROCESSED',
    externalId: crypto.randomUUID(),
    referenceExternalId: null,
    referenceId: null,
    failureCode: null,
    processedAt: AT,
    observedBalance: '0.00',
    ...overrides,
  };
}

/**
 * Commits a wallet opened with `balance` plus — when positive — its OPENING transaction and
 * ledger entry, the way the application will. Returns ids for follow-up statements.
 */
async function openWallet(balance = '100.00', currency = 'BRL') {
  const wallet = { id: crypto.randomUUID(), playerId: crypto.randomUUID(), currency, balance };
  const opening = transaction({
    walletId: wallet.id,
    playerId: wallet.playerId,
    kind: 'OPENING',
    amount: balance,
    currency,
  });
  await sql.begin(async (tx) => {
    await insertWallet(tx, wallet);
    if (balance === '0.00') return;
    await insertTransaction(tx, opening);
    await insertEntry(tx, {
      walletId: wallet.id,
      transactionId: opening.id,
      direction: 'CREDIT',
      amount: balance,
      before: '0.00',
      after: balance,
      currency,
    });
  });
  return { wallet, opening };
}

/** Commits a balance movement: transaction + ledger entry + wallet update, atomically. */
async function applyMovement(
  wallet: WalletRow,
  version: number,
  row: TransactionRow,
  direction: 'DEBIT' | 'CREDIT',
  before: string,
  after: string,
) {
  await sql.begin(async (tx) => {
    await tx`update wallets set balance = ${after}, version = ${version + 1} where id = ${wallet.id}`;
    await insertTransaction(tx, row);
    await insertEntry(tx, {
      walletId: wallet.id,
      transactionId: row.id,
      direction,
      amount: row.amount,
      before,
      after,
    });
  });
}

// ---------------------------------------------------------------- tests

describe('migrations', () => {
  it('round-trip down → up and leave every table in place', async () => {
    const migrator = orm.getMigrator();
    const executed = await migrator.getExecutedMigrations();

    await migrator.down({ to: 0 });
    const [afterDown] = await sql`select to_regclass('public.wallets') as wallets`;
    expect(afterDown.wallets).toBeNull();

    await migrator.up();
    expect((await migrator.getExecutedMigrations()).length).toBe(executed.length);
    const tables = await sql`
      select table_name from information_schema.tables
       where table_schema = 'public' and table_name not like 'mikro_orm%'
       order by table_name`;
    expect(tables.map((t: { table_name: string }) => t.table_name)).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });
});

describe('wallets', () => {
  it('allows at most one wallet per player and currency', async () => {
    const { wallet } = await openWallet('0.00');

    await expectPgError(
      insertWallet(sql, { ...wallet, id: crypto.randomUUID() }),
      UNIQUE_VIOLATION,
      /wallets_player_currency_uq/,
    );
  });

  it('allows the same player in another currency', async () => {
    const { wallet } = await openWallet('0.00');

    await insertWallet(sql, { ...wallet, id: crypto.randomUUID(), currency: 'USD' });
  });

  it('rejects a negative balance', async () => {
    const { wallet } = await openWallet('10.00');

    await expectPgError(
      sql`update wallets set balance = -1, version = 2 where id = ${wallet.id}`,
      CHECK_VIOLATION,
      /balance_check/,
    );
  });

  it('must be created at version 1', async () => {
    await expectPgError(
      insertWallet(
        sql,
        { id: crypto.randomUUID(), playerId: crypto.randomUUID(), currency: 'BRL', balance: '0' },
        2,
      ),
      CHECK_VIOLATION,
      /version 1/,
    );
  });

  it('only bumps version, by exactly 1, when the balance changes', async () => {
    const { wallet } = await openWallet('0.00');

    await expectPgError(
      sql`update wallets set version = 2 where id = ${wallet.id}`,
      CHECK_VIOLATION,
      /must not change/,
    );
  });

  it('keeps identity columns immutable and cannot be deleted', async () => {
    const { wallet } = await openWallet('0.00');

    await expectPgError(
      sql`update wallets set currency = 'USD' where id = ${wallet.id}`,
      INTEGRITY_VIOLATION,
      /immutable/,
    );
    await expectPgError(sql`delete from wallets where id = ${wallet.id}`, INTEGRITY_VIOLATION);
  });
});

describe('balance ↔ ledger consistency (deferred, checked at commit)', () => {
  it('accepts a wallet opened together with its ledger entry', async () => {
    const { wallet } = await openWallet('100.00');

    const [row] = await sql`select balance, version from wallets where id = ${wallet.id}`;
    expect(row).toEqual({ balance: '100.00', version: 1 });
  });

  it('rejects a balance change without a ledger entry', async () => {
    const { wallet } = await openWallet('100.00');

    await expectPgError(
      sql`update wallets set balance = 80, version = 2 where id = ${wallet.id}`,
      CHECK_VIOLATION,
      /diverges from ledger/,
    );
  });

  it('rejects a ledger entry without the matching balance change', async () => {
    const { wallet } = await openWallet('100.00');
    const bet = transaction({ walletId: wallet.id, playerId: wallet.playerId, amount: '20.00' });

    await expectPgError(
      sql.begin(async (tx) => {
        await insertTransaction(tx, bet);
        await insertEntry(tx, {
          walletId: wallet.id,
          transactionId: bet.id,
          direction: 'DEBIT',
          amount: '20.00',
          before: '100.00',
          after: '80.00',
        });
      }),
      CHECK_VIOLATION,
      /diverges from ledger/,
    );
  });

  it('rejects a wallet opened with a balance but no ledger entry', async () => {
    await expectPgError(
      insertWallet(sql, {
        id: crypto.randomUUID(),
        playerId: crypto.randomUUID(),
        currency: 'BRL',
        balance: '50.00',
      }),
      CHECK_VIOLATION,
      /diverges from ledger/,
    );
  });
});

describe('wallet_ledger_entries', () => {
  it('chains entries: balance_before must equal the previous balance_after', async () => {
    const { wallet } = await openWallet('100.00');
    const bet = transaction({ walletId: wallet.id, playerId: wallet.playerId, amount: '20.00' });

    await expectPgError(
      applyMovement(wallet, 1, bet, 'DEBIT', '90.00', '70.00'),
      CHECK_VIOLATION,
      /previous balance_after is 100.00/,
    );
  });

  it('enforces the entry arithmetic', async () => {
    const { wallet } = await openWallet('100.00');
    const bet = transaction({ walletId: wallet.id, playerId: wallet.playerId, amount: '20.00' });

    await expectPgError(
      applyMovement(wallet, 1, bet, 'DEBIT', '100.00', '81.00'),
      CHECK_VIOLATION,
      /arithmetic_ck/,
    );
  });

  it('must match its transaction amount, wallet and currency', async () => {
    const { wallet } = await openWallet('100.00');
    const bet = transaction({ walletId: wallet.id, playerId: wallet.playerId, amount: '20.00' });

    await expectPgError(
      sql.begin(async (tx) => {
        await tx`update wallets set balance = 70, version = 2 where id = ${wallet.id}`;
        await insertTransaction(tx, bet);
        await insertEntry(tx, {
          walletId: wallet.id,
          transactionId: bet.id,
          direction: 'DEBIT',
          amount: '30.00',
          before: '100.00',
          after: '70.00',
        });
      }),
      FOREIGN_KEY_VIOLATION,
      /wallet_ledger_entries_transaction_fk/,
    );
  });

  it('allows at most one entry per transaction', async () => {
    const { wallet, opening } = await openWallet('100.00');

    await expectPgError(
      sql.begin(async (tx) => {
        await tx`update wallets set balance = 200, version = 2 where id = ${wallet.id}`;
        await insertEntry(tx, {
          walletId: wallet.id,
          transactionId: opening.id,
          direction: 'CREDIT',
          amount: '100.00',
          before: '100.00',
          after: '200.00',
        });
      }),
      UNIQUE_VIOLATION,
      /wallet_ledger_entries_transaction_uq/,
    );
  });

  it('is append-only: no UPDATE, DELETE or TRUNCATE', async () => {
    const { wallet } = await openWallet('100.00');

    await expectPgError(
      sql`update wallet_ledger_entries set amount = 1 where wallet_id = ${wallet.id}`,
      INTEGRITY_VIOLATION,
      /UPDATE is not allowed/,
    );
    await expectPgError(
      sql`delete from wallet_ledger_entries where wallet_id = ${wallet.id}`,
      INTEGRITY_VIOLATION,
      /DELETE is not allowed/,
    );
    await expectPgError(
      sql`truncate wallet_ledger_entries cascade`,
      INTEGRITY_VIOLATION,
      /TRUNCATE is not allowed/,
    );
  });

  it('assigns increasing per-wallet sequences and reconciles with the stored balance', async () => {
    const { wallet } = await openWallet('100.00');
    await applyMovement(
      wallet,
      1,
      transaction({ walletId: wallet.id, playerId: wallet.playerId, amount: '25.00' }),
      'DEBIT',
      '100.00',
      '75.00',
    );
    await applyMovement(
      wallet,
      2,
      transaction({ walletId: wallet.id, playerId: wallet.playerId, kind: 'WIN', amount: '5.50' }),
      'CREDIT',
      '75.00',
      '80.50',
    );

    const [reconciled] = await sql`
      select w.balance as stored,
             sum(case e.direction when 'CREDIT' then e.amount else -e.amount end) as calculated,
             count(*)::int as entries,
             bool_and(e.sequence > 0) as sequenced
        from wallets w join wallet_ledger_entries e on e.wallet_id = w.id
       where w.id = ${wallet.id}
       group by w.balance`;
    expect(reconciled).toEqual({ stored: '80.50', calculated: '80.50', entries: 3, sequenced: true });
  });
});

describe('wager_transactions', () => {
  it('enforces idempotency key and (provider, external id) uniqueness', async () => {
    const { wallet } = await openWallet('0.00');
    const loss = transaction({ walletId: wallet.id, playerId: wallet.playerId, kind: 'LOSS', amount: '0' });
    await insertTransaction(sql, loss);

    await expectPgError(
      insertTransaction(sql, { ...loss, id: crypto.randomUUID() }),
      UNIQUE_VIOLATION,
      /wager_transactions_idempotency_key_uq/,
    );
  });

  it.each([
    ['zero BET amount', { kind: 'BET', amount: '0' }, /amount_ck/],
    ['negative amount', { kind: 'WIN', amount: '-1' }, /amount_ck/],
    ['REFUND without reference', { kind: 'REFUND', status: 'PENDING', processedAt: null }, /reference_required_ck/],
    ['BET with reference', { referenceExternalId: 'x' }, /reference_allowed_ck/],
    ['REJECTED without failure code', { status: 'REJECTED', processedAt: null }, /failure_code_ck/],
    ['PROCESSED with failure code', { failureCode: 'INSUFFICIENT_FUNDS' }, /failure_code_ck/],
    ['PROCESSED without processed_at', { processedAt: null }, /processed_at_ck/],
    ['unknown kind', { kind: 'JACKPOT' }, /kind_check/],
    ['unknown status', { status: 'DONE', processedAt: null }, /status_check/],
    ['decided transaction without observed balance', { observedBalance: null }, /observed_balance_ck/],
    ['negative observed balance', { observedBalance: '-1' }, /observed_balance_check/],
  ] as const)('rejects %s', async (_, overrides, message) => {
    const { wallet } = await openWallet('0.00');

    await expectPgError(
      insertTransaction(sql, transaction({ walletId: wallet.id, playerId: wallet.playerId, ...overrides })),
      CHECK_VIOLATION,
      message,
    );
  });

  it('requires an existing wallet', async () => {
    await expectPgError(
      insertTransaction(sql, transaction({ walletId: crypto.randomUUID(), playerId: 'p', kind: 'LOSS', amount: '0' })),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('a reference can be reversed at most once, by REFUND or ROLLBACK', async () => {
    const { wallet } = await openWallet('100.00');
    const bet = transaction({ walletId: wallet.id, playerId: wallet.playerId, amount: '25.00' });
    await applyMovement(wallet, 1, bet, 'DEBIT', '100.00', '75.00');
    const refund = transaction({
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: 'REFUND',
      amount: '25.00',
      referenceExternalId: bet.externalId,
      referenceId: bet.id,
    });
    await applyMovement(wallet, 2, refund, 'CREDIT', '75.00', '100.00');

    const rollback = { ...refund, id: crypto.randomUUID(), externalId: crypto.randomUUID(), kind: 'ROLLBACK' };
    await expectPgError(
      applyMovement(wallet, 3, rollback, 'CREDIT', '100.00', '125.00'),
      UNIQUE_VIOLATION,
      /wager_transactions_single_reversal_uq/,
    );

    // A REJECTED attempt against the same reference stays auditable.
    await insertTransaction(sql, {
      ...rollback,
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
      processedAt: null,
    });
  });

  it('freezes terminal transactions and forbids returning to PENDING', async () => {
    const { wallet } = await openWallet('0.00');
    const processed = transaction({ walletId: wallet.id, playerId: wallet.playerId, kind: 'LOSS', amount: '0' });
    const pending = transaction({
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: 'REFUND',
      referenceExternalId: 'later',
      status: 'PENDING_REFERENCE',
      processedAt: null,
    });
    await insertTransaction(sql, processed);
    await insertTransaction(sql, pending);

    await expectPgError(
      sql`update wager_transactions set status = 'REJECTED', failure_code = 'X', processed_at = null where id = ${processed.id}`,
      INTEGRITY_VIOLATION,
      /is terminal/,
    );
    await expectPgError(
      sql`update wager_transactions set status = 'PENDING' where id = ${pending.id}`,
      INTEGRITY_VIOLATION,
      /cannot return to PENDING/,
    );
    await expectPgError(
      sql`update wager_transactions set amount = 99 where id = ${pending.id}`,
      INTEGRITY_VIOLATION,
      /immutable/,
    );
    await sql`
      update wager_transactions
         set reference_attempts = 2, next_reference_check_at = now()
       where id = ${pending.id}`;
    await expectPgError(
      sql`delete from wager_transactions where id = ${pending.id}`,
      INTEGRITY_VIOLATION,
    );
  });
});

describe('inbox and outbox', () => {
  it('deduplicates inbox messages per consumer', async () => {
    const messageId = crypto.randomUUID();
    const insert = (consumer: string) => sql`
      insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
      values (${consumer}, ${messageId}, ${HASH}, ${AT})`;
    await insert('wager-transactions');
    await insert('another-consumer');

    await expectPgError(insert('wager-transactions'), UNIQUE_VIOLATION, /inbox_messages_pk/);
  });

  it('keeps outbox events immutable and unpublished events undeletable', async () => {
    const id = crypto.randomUUID();
    await sql`
      insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
      values (${id}, ${crypto.randomUUID()}, 'WalletBalanceChanged', ${{ eventId: id }}, ${AT}, ${AT})`;

    await expectPgError(
      sql`update outbox_messages set payload = '{}' where id = ${id}`,
      INTEGRITY_VIOLATION,
      /immutable/,
    );
    await expectPgError(sql`delete from outbox_messages where id = ${id}`, INTEGRITY_VIOLATION, /unpublished/);

    await sql`update outbox_messages set attempts = 1, next_attempt_at = now() where id = ${id}`;
    await sql`update outbox_messages set published_at = now() where id = ${id}`;
    await expectPgError(
      sql`update outbox_messages set published_at = now() + interval '1 second' where id = ${id}`,
      INTEGRITY_VIOLATION,
      /already published/,
    );
    await sql`delete from outbox_messages where id = ${id}`;
  });
});
