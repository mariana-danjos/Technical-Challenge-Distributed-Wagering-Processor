// Requires `docker compose up -d postgres`. OpenWallet and ReconcileWallet against real PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { InvalidMoneyError } from '../../src/domain/shared/domain-error';
import {
  countRows,
  createWageringHarness,
  expectLedgerConsistent,
  openTestWallet,
  outboxEventTypes,
  wagerCommand,
  type WageringHarness,
} from '../support/wagering-harness';

let harness: WageringHarness;

beforeAll(async () => {
  harness = await createWageringHarness();
});

afterAll(async () => {
  await harness?.close();
});

describe('OpenWallet', () => {
  it('opens at version 1 with an OPENING transaction, CREDIT entry and event — atomically', async () => {
    const wallet = await openTestWallet(harness, '1000.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(await countRows(harness.sql, 'entries', wallet.id)).toBe(1);
    const [opening] = await harness.sql`
      select kind, status, amount::text from wager_transactions where wallet_id = ${wallet.id}`;
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' });
    expect(await outboxEventTypes(harness.sql, wallet.id)).toEqual(['WalletBalanceChanged']);
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('1000.00');
  });

  it('opens a zero-balance wallet without transaction, entry or event', async () => {
    const wallet = await openTestWallet(harness, '0');

    expect(wallet.balance.amount).toBe('0.00');
    expect(await countRows(harness.sql, 'entries', wallet.id)).toBe(0);
    expect(await outboxEventTypes(harness.sql, wallet.id)).toEqual([]);
  });

  it('refuses a second wallet for the same player and currency, but allows another currency', async () => {
    const playerId = crypto.randomUUID();
    const open = (currency: string) =>
      harness.openWallet.execute({
        playerId,
        initialBalance: { amount: '10.00', currency },
        correlationId: crypto.randomUUID(),
      });

    expect((await open('BRL')).outcome).toBe('OPENED');
    expect(await open('BRL')).toEqual({ outcome: 'ALREADY_EXISTS' });
    expect((await open('USD')).outcome).toBe('OPENED');
  });

  it('concurrent duplicate opens produce exactly one wallet', async () => {
    const playerId = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        harness.openWallet.execute({
          playerId,
          initialBalance: { amount: '50.00', currency: 'BRL' },
          correlationId: crypto.randomUUID(),
        }),
      ),
    );

    expect(results.filter((r) => r.outcome === 'OPENED')).toHaveLength(1);
    const [row] = await harness.sql`select count(*)::int as n from wallets where player_id = ${playerId}`;
    expect(row.n).toBe(1);
  });

  it('rejects invalid initial balances before touching the database', async () => {
    await expect(
      harness.openWallet.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1e3', currency: 'BRL' },
        correlationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(InvalidMoneyError);
  });
});

describe('ReconcileWallet', () => {
  it('reports a consistent wallet after activity', async () => {
    const wallet = await openTestWallet(harness, '1000.00');
    await harness.submit.execute(wagerCommand(wallet, 'BET', '25.00'));
    await harness.submit.execute(wagerCommand(wallet, 'WIN', '10.50'));

    const report = await harness.reconcile.execute(wallet.id);

    expect(report).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '985.50', currency: 'BRL' },
      calculatedBalance: { amount: '985.50', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  it('flags and reports a divergence without correcting it', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    // Simulate corruption the schema normally prevents: bypass the deferred consistency trigger.
    await harness.sql.begin(async (tx) => {
      await tx`alter table wallets disable trigger wallets_ledger_consistency`;
      await tx`update wallets set balance = 90, version = 2 where id = ${wallet.id}`;
      await tx`alter table wallets enable trigger wallets_ledger_consistency`;
    });

    const report = await harness.reconcile.execute(wallet.id);

    expect(report?.consistent).toBe(false);
    expect(report?.difference).toEqual({ amount: '-10.00', currency: 'BRL' });
    expect(harness.telemetry.divergences).toContainEqual({
      walletId: wallet.id,
      storedBalance: '90.00',
      calculatedBalance: '100.00',
      difference: '-10.00',
      checkedEntries: 1,
    });
    const [row] = await harness.sql`select balance::text from wallets where id = ${wallet.id}`;
    expect(row.balance).toBe('90.00');
  });

  it('returns undefined for unknown wallets', async () => {
    expect(await harness.reconcile.execute(crypto.randomUUID())).toBeUndefined();
    expect(await harness.reconcile.execute('not-a-uuid')).toBeUndefined();
  });
});
