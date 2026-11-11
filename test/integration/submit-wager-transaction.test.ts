// Requires `docker compose up -d postgres`. SubmitWagerTransaction against real PostgreSQL.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { WalletView } from '../../src/application/wallets/open-wallet';
import { InvalidWagerTransactionError } from '../../src/domain/shared/domain-error';
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
const touchedWallets: WalletView[] = [];

beforeAll(async () => {
  harness = await createWageringHarness();
});

afterEach(async () => {
  for (const wallet of touchedWallets.splice(0)) {
    await expectLedgerConsistent(harness.sql, wallet.id);
  }
});

afterAll(async () => {
  await harness?.close();
});

async function wallet(amount: string) {
  const opened = await openTestWallet(harness, amount);
  touchedWallets.push(opened);
  return opened;
}

describe('SubmitWagerTransaction', () => {
  describe('BET', () => {
    it('debits, records one DEBIT entry and enqueues Processed + BalanceChanged', async () => {
      const w = await wallet('1000.00');

      const result = await harness.submit.execute(wagerCommand(w, 'BET', '25.00'));

      expect(result).toMatchObject({
        outcome: 'RECORDED',
        status: 'PROCESSED',
        balance: { amount: '975.00', currency: 'BRL' },
        failureCode: undefined,
        idempotentReplay: false,
      });
      expect(await countRows(harness.sql, 'debits', w.id)).toBe(1);
      expect(await outboxEventTypes(harness.sql, w.id)).toEqual([
        'WalletBalanceChanged', // opening
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      const [row] = await harness.sql`select version from wallets where id = ${w.id}`;
      expect(row.version).toBe(2);
    });

    it('rejects INSUFFICIENT_FUNDS: persisted, auditable, no ledger entry, Rejected event', async () => {
      const w = await wallet('10.00');

      const result = await harness.submit.execute(wagerCommand(w, 'BET', '10.01'));

      expect(result).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '10.00', currency: 'BRL' },
      });
      expect(await countRows(harness.sql, 'debits', w.id)).toBe(0);
      expect((await outboxEventTypes(harness.sql, w.id)).at(-1)).toBe('WagerTransactionRejected');
    });
  });

  describe('LOSS', () => {
    it('is processed without moving the balance, entry or BalanceChanged event', async () => {
      const w = await wallet('100.00');

      const result = await harness.submit.execute(wagerCommand(w, 'LOSS', '0'));

      expect(result).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
      expect(await countRows(harness.sql, 'entries', w.id)).toBe(1);
      expect((await outboxEventTypes(harness.sql, w.id)).at(-1)).toBe('WagerTransactionProcessed');
    });
  });

  describe('idempotency', () => {
    it('replays the original response, including the balance observed back then', async () => {
      const w = await wallet('1000.00');
      const bet = wagerCommand(w, 'BET', '25.00');
      const original = await harness.submit.execute(bet);
      await harness.submit.execute(wagerCommand(w, 'WIN', '100.00'));

      const replay = await harness.submit.execute({ ...bet, correlationId: crypto.randomUUID() });

      expect(replay).toEqual({ ...original, idempotentReplay: true } as typeof replay);
      expect(replay).toMatchObject({ balance: { amount: '975.00' } });
      expect(await countRows(harness.sql, 'debits', w.id)).toBe(1);
    });

    it('treats "25" and "25.00" as the same payload', async () => {
      const w = await wallet('100.00');
      const bet = wagerCommand(w, 'BET', '25');
      await harness.submit.execute(bet);

      const replay = await harness.submit.execute({ ...bet, money: { amount: '25.00', currency: 'BRL' } });

      expect(replay).toMatchObject({ idempotentReplay: true });
    });

    it('same key with a different payload is a conflict, not a replay', async () => {
      const w = await wallet('100.00');
      const bet = wagerCommand(w, 'BET', '25.00');
      const original = await harness.submit.execute(bet);

      const conflict = await harness.submit.execute({ ...bet, money: { amount: '26.00', currency: 'BRL' } });

      expect(conflict).toEqual({
        outcome: 'IDEMPOTENCY_CONFLICT',
        transactionId: original.outcome === 'RECORDED' ? original.transactionId : '',
      });
      expect(await countRows(harness.sql, 'debits', w.id)).toBe(1);
    });

    it('same external id under another idempotency key is a conflict', async () => {
      const w = await wallet('100.00');
      const bet = wagerCommand(w, 'BET', '25.00');
      await harness.submit.execute(bet);

      const result = await harness.submit.execute({ ...bet, idempotencyKey: 'another-key' });

      expect(result.outcome).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('replays rejections too', async () => {
      const w = await wallet('1.00');
      const bet = wagerCommand(w, 'BET', '5.00');
      await harness.submit.execute(bet);

      expect(await harness.submit.execute(bet)).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        idempotentReplay: true,
      });
    });
  });

  describe('reversals', () => {
    it('REFUND credits back a BET once; a second reversal is REFERENCE_ALREADY_REVERSED', async () => {
      const w = await wallet('100.00');
      const bet = wagerCommand(w, 'BET', '40.00');
      await harness.submit.execute(bet);

      const refund = await harness.submit.execute(
        wagerCommand(w, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }),
      );
      const rollback = await harness.submit.execute(
        wagerCommand(w, 'ROLLBACK', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }),
      );

      expect(refund).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
      expect(rollback).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_ALREADY_REVERSED',
        balance: { amount: '100.00' },
      });
    });

    it('ROLLBACK of a WIN debits; when the money is gone it is REVERSAL_INSUFFICIENT_FUNDS', async () => {
      const w = await wallet('0');
      const win = wagerCommand(w, 'WIN', '30.00');
      await harness.submit.execute(win);
      await harness.submit.execute(wagerCommand(w, 'BET', '25.00'));

      const rollback = await harness.submit.execute(
        wagerCommand(w, 'ROLLBACK', '30.00', { referenceExternalTransactionId: win.externalTransactionId }),
      );

      expect(rollback).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
        balance: { amount: '5.00' },
      });
    });

    it('a REFUND arriving before its BET is parked as PENDING_REFERENCE', async () => {
      const w = await wallet('100.00');
      const betExternalId = crypto.randomUUID();

      const refund = await harness.submit.execute(
        wagerCommand(w, 'REFUND', '40.00', { referenceExternalTransactionId: betExternalId }),
      );

      expect(refund).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });
      expect((await outboxEventTypes(harness.sql, w.id)).at(-1)).toBe('WagerTransactionPendingReference');
      if (refund.outcome !== 'RECORDED') throw new Error('expected a recorded transaction');
      const [row] = await harness.sql`
        select reference_attempts, next_reference_check_at is not null as scheduled
          from wager_transactions where id = ${refund.transactionId}`;
      expect(row).toEqual({ reference_attempts: 1, scheduled: true });
    });
  });

  describe('wallet checks', () => {
    it('unknown wallet → WALLET_NOT_FOUND and nothing is stored', async () => {
      const w = await wallet('100.00');
      const bet = wagerCommand(w, 'BET', '1.00', { walletId: crypto.randomUUID() });

      expect(await harness.submit.execute(bet)).toEqual({ outcome: 'WALLET_NOT_FOUND' });
      expect(await harness.submit.execute({ ...bet, walletId: 'not-a-uuid' })).toEqual({
        outcome: 'WALLET_NOT_FOUND',
      });
      const [row] = await harness.sql`
        select count(*)::int as n from wager_transactions where idempotency_key = ${bet.idempotencyKey}`;
      expect(row.n).toBe(0);
    });

    it('CURRENCY_MISMATCH is persisted with the balance in the wallet currency', async () => {
      const w = await wallet('100.00');

      const result = await harness.submit.execute(
        wagerCommand(w, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } }),
      );

      expect(result).toMatchObject({
        status: 'REJECTED',
        failureCode: 'CURRENCY_MISMATCH',
        balance: { amount: '100.00', currency: 'BRL' },
      });
    });

    it('a player using somebody else’s wallet is WALLET_PLAYER_MISMATCH', async () => {
      const w = await wallet('100.00');

      expect(
        await harness.submit.execute(wagerCommand(w, 'BET', '1.00', { playerId: 'intruder' })),
      ).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
    });
  });

  it('refuses OPENING from providers', async () => {
    const w = await wallet('100.00');

    await expect(harness.submit.execute(wagerCommand(w, 'OPENING', '1.00'))).rejects.toThrow(
      InvalidWagerTransactionError,
    );
  });
});
