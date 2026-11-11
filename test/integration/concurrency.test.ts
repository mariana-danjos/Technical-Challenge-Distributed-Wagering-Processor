// Requires `docker compose up -d postgres`. Real parallelism: every call runs its own SQL
// transaction on its own pooled connection; nothing is mocked or sequenced by the test.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { TransientInfrastructureError } from '../../src/application/errors';
import {
  countRows,
  createWageringHarness,
  expectLedgerConsistent,
  holdWalletLock,
  openTestWallet,
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

describe('concurrency', () => {
  it('mandatory scenario: 100.00 and two simultaneous 80.00 bets → exactly one debit', async () => {
    const wallet = await openTestWallet(harness, '100.00');

    const results = await Promise.all([
      harness.submit.execute(wagerCommand(wallet, 'BET', '80.00')),
      harness.submit.execute(wagerCommand(wallet, 'BET', '80.00')),
    ]);

    const statuses = results.map((r) => (r.outcome === 'RECORDED' ? String(r.status) : r.outcome)).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(results).toContainEqual(expect.objectContaining({ failureCode: 'INSUFFICIENT_FUNDS' }));
    expect(await countRows(harness.sql, 'debits', wallet.id)).toBe(1);
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('20.00');
  });

  it('the same bet sent 50 times in parallel debits once; the other 49 are replays', async () => {
    const wallet = await openTestWallet(harness, '1000.00');
    const bet = wagerCommand(wallet, 'BET', '25.00');

    const results = await Promise.all(
      Array.from({ length: 50 }, () => harness.submit.execute({ ...bet, correlationId: crypto.randomUUID() })),
    );

    const recorded = results.filter((r) => r.outcome === 'RECORDED');
    expect(recorded).toHaveLength(50);
    expect(recorded.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(recorded.map((r) => r.transactionId)).size).toBe(1);
    expect(recorded.every((r) => r.status === 'PROCESSED' && r.balance.amount === '975.00')).toBe(true);
    expect(await countRows(harness.sql, 'debits', wallet.id)).toBe(1);
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('975.00');
  });

  it('a hot wallet under mixed parallel BET/WIN load never loses an update', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const commands = Array.from({ length: 60 }, (_, i) =>
      i % 3 === 0 ? wagerCommand(wallet, 'WIN', '5.00') : wagerCommand(wallet, 'BET', '7.00'),
    );

    const results = await Promise.all(commands.map((command) => harness.submit.execute(command)));

    const processed = results.filter((r) => r.outcome === 'RECORDED' && r.status === 'PROCESSED');
    const rejected = results.filter((r) => r.outcome === 'RECORDED' && r.status === 'REJECTED');
    expect(processed.length + rejected.length).toBe(60);
    expect(rejected.every((r) => r.outcome === 'RECORDED' && r.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    // One entry per processed transaction plus the opening credit; balance matches the ledger.
    expect(await countRows(harness.sql, 'entries', wallet.id)).toBe(processed.length + 1);
    const [row] = await harness.sql`select version from wallets where id = ${wallet.id}`;
    expect(row.version).toBe(processed.length + 1);
    await expectLedgerConsistent(harness.sql, wallet.id);
  });

  it('different wallets are processed in parallel and independently', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openTestWallet(harness, '100.00')));

    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () => harness.submit.execute(wagerCommand(wallet, 'BET', '10.00'))),
      ),
    );

    for (const wallet of wallets) {
      expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('50.00');
    }
  });

  it('the lock is per wallet: a locked wallet blocks only its own operations', async () => {
    const busy = await openTestWallet(harness, '100.00');
    const free = await openTestWallet(harness, '100.00');
    const lock = await holdWalletLock(harness.sql, busy.id);

    let busyDone = false;
    const busyBet = harness.submit.execute(wagerCommand(busy, 'BET', '10.00')).then((r) => {
      busyDone = true;
      return r;
    });
    const freeBet = await harness.submit.execute(wagerCommand(free, 'BET', '10.00'));

    expect(freeBet).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00' } });
    expect(busyDone).toBe(false);

    await lock.release();
    expect(await busyBet).toMatchObject({ status: 'PROCESSED', balance: { amount: '90.00' } });
    await expectLedgerConsistent(harness.sql, busy.id);
    await expectLedgerConsistent(harness.sql, free.id);
  });

  it('a lock wait beyond lock_timeout fails transiently and leaves no trace', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const { submit } = harness.withOptions({ lockTimeoutMs: 200 });
    const lock = await holdWalletLock(harness.sql, wallet.id);

    const bet = wagerCommand(wallet, 'BET', '10.00');
    try {
      await expect(submit.execute(bet)).rejects.toBeInstanceOf(TransientInfrastructureError);
    } finally {
      await lock.release();
    }

    // Retrying after the transient failure applies the bet exactly once.
    expect(await harness.submit.execute(bet)).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('90.00');
  });

  it('same idempotency key racing on two wallets: the UNIQUE constraint decides, no double effect', async () => {
    const first = await openTestWallet(harness, '100.00');
    const second = await openTestWallet(harness, '100.00');
    const bet = wagerCommand(first, 'BET', '10.00');

    // Different wallets → different row locks, so only the database UNIQUE constraints serialize these.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        harness.submit.execute(
          i % 2 === 0 ? bet : { ...bet, walletId: second.id, playerId: second.playerId },
        ),
      ),
    );

    const applied = results.filter((r) => r.outcome === 'RECORDED' && !r.idempotentReplay);
    expect(applied).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'IDEMPOTENCY_CONFLICT').length).toBeGreaterThan(0);
    const debits =
      (await countRows(harness.sql, 'debits', first.id)) + (await countRows(harness.sql, 'debits', second.id));
    expect(debits).toBe(1);
    await expectLedgerConsistent(harness.sql, first.id);
    await expectLedgerConsistent(harness.sql, second.id);
  });

  it('parallel REFUND and ROLLBACK of the same BET: only one reversal applies', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const bet = wagerCommand(wallet, 'BET', '40.00');
    await harness.submit.execute(bet);
    const reference = { referenceExternalTransactionId: bet.externalTransactionId };

    const results = await Promise.all([
      harness.submit.execute(wagerCommand(wallet, 'REFUND', '40.00', reference)),
      harness.submit.execute(wagerCommand(wallet, 'ROLLBACK', '40.00', reference)),
      harness.submit.execute(wagerCommand(wallet, 'REFUND', '40.00', reference)),
    ]);

    const statuses = results.map((r) => (r.outcome === 'RECORDED' ? String(r.status) : r.outcome));
    expect(statuses.filter((s) => s === 'PROCESSED')).toHaveLength(1);
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('100.00');
  });
});
