import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../src/domain/money/money';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import {
  settleWagerTransaction,
  type SettlementInput,
} from '../../../src/domain/wagering/wager-settlement';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { NOW, nextId, processed, wagerTransaction, walletWith } from '../../support/domain-fixtures';

const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;
const { Processed, Rejected, PendingReference } = WagerTransactionStatus;

function settle(
  transaction: WagerTransaction,
  wallet: Wallet,
  extra: Partial<SettlementInput> = {},
) {
  return settleWagerTransaction({
    transaction,
    wallet,
    reference: undefined,
    referenceAlreadyReversed: false,
    ledgerEntryId: nextId('entry'),
    at: NOW,
    ...extra,
  });
}

function referencing(kind: WagerTransactionKind, reference: WagerTransaction, amount?: string) {
  return wagerTransaction(kind, amount ?? reference.money.toString(), {
    referenceExternalTransactionId: reference.externalTransactionId,
  });
}

describe('settleWagerTransaction', () => {
  describe('BET', () => {
    it('debits the wallet and produces one DEBIT entry', () => {
      const wallet = walletWith('100.00');
      const bet = wagerTransaction(Bet, '25.00');

      const outcome = settle(bet, wallet);

      expect(outcome.status).toBe(Processed);
      expect(outcome.status === Processed && outcome.entry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toString()).toBe('75.00');
      expect(bet.status).toBe(Processed);
    });

    it('rejects with INSUFFICIENT_FUNDS and leaves the wallet untouched', () => {
      const wallet = walletWith('100.00');
      const bet = wagerTransaction(Bet, '100.01');

      const outcome = settle(bet, wallet);

      expect(outcome).toEqual({ status: Rejected, failureCode: FailureCode.InsufficientFunds });
      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    it('mandatory scenario, sequential form: 100.00 with two 80.00 bets → one processed', () => {
      const wallet = walletWith('100.00');
      const first = settle(wagerTransaction(Bet, '80.00'), wallet);
      const second = settle(wagerTransaction(Bet, '80.00'), wallet);

      expect(first.status).toBe(Processed);
      expect(second).toEqual({ status: Rejected, failureCode: FailureCode.InsufficientFunds });
      expect(wallet.balance.toString()).toBe('20.00');
    });
  });

  describe('WIN', () => {
    it('credits without a reference', () => {
      const wallet = walletWith('10.00');

      const outcome = settle(wagerTransaction(Win, '50.00'), wallet);

      expect(outcome.status).toBe(Processed);
      expect(wallet.balance.toString()).toBe('60.00');
    });

    it('credits and links the referenced BET of the same round', () => {
      const wallet = walletWith('10.00');
      const bet = processed(wagerTransaction(Bet, '10.00'));
      const win = referencing(Win, bet, '30.00');

      settle(win, wallet, { reference: bet });

      expect(win.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.toString()).toBe('40.00');
    });
  });

  describe('LOSS', () => {
    it('is processed without moving the balance or producing an entry', () => {
      const wallet = walletWith('10.00');

      const outcome = settle(wagerTransaction(Loss, '0.00'), wallet);

      expect(outcome).toEqual({ status: Processed, entry: undefined });
      expect(wallet.balance.toString()).toBe('10.00');
      expect(wallet.version).toBe(1);
    });
  });

  describe('REFUND', () => {
    it('credits back a processed BET', () => {
      const wallet = walletWith('75.00');
      const bet = processed(wagerTransaction(Bet, '25.00'));
      const refund = referencing(Refund, bet);

      const outcome = settle(refund, wallet, { reference: bet });

      expect(outcome.status === Processed && outcome.entry?.direction).toBe(LedgerDirection.Credit);
      expect(refund.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.toString()).toBe('100.00');
    });

    it('only references BET', () => {
      const wallet = walletWith('75.00');
      const win = processed(wagerTransaction(Win, '25.00'));

      const outcome = settle(referencing(Refund, win), wallet, { reference: win });

      expect(outcome).toEqual({ status: Rejected, failureCode: FailureCode.ReferenceKindNotAllowed });
      expect(wallet.balance.toString()).toBe('75.00');
    });

    it('rejects partial amounts with AMOUNT_MISMATCH', () => {
      const wallet = walletWith('75.00');
      const bet = processed(wagerTransaction(Bet, '25.00'));

      const outcome = settle(referencing(Refund, bet, '10.00'), wallet, { reference: bet });

      expect(outcome).toEqual({ status: Rejected, failureCode: FailureCode.AmountMismatch });
    });

    it('cannot reverse a reference twice', () => {
      const wallet = walletWith('75.00');
      const bet = processed(wagerTransaction(Bet, '25.00'));

      const outcome = settle(referencing(Refund, bet), wallet, {
        reference: bet,
        referenceAlreadyReversed: true,
      });

      expect(outcome).toEqual({
        status: Rejected,
        failureCode: FailureCode.ReferenceAlreadyReversed,
      });
      expect(wallet.balance.toString()).toBe('75.00');
    });
  });

  describe('ROLLBACK', () => {
    it('of a BET credits', () => {
      const wallet = walletWith('75.00');
      const bet = processed(wagerTransaction(Bet, '25.00'));

      settle(referencing(Rollback, bet), wallet, { reference: bet });

      expect(wallet.balance.toString()).toBe('100.00');
    });

    it('of a WIN debits', () => {
      const wallet = walletWith('130.00');
      const win = processed(wagerTransaction(Win, '30.00'));

      const outcome = settle(referencing(Rollback, win), wallet, { reference: win });

      expect(outcome.status === Processed && outcome.entry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toString()).toBe('100.00');
    });

    it('of a REFUND debits (undoing the refund is allowed)', () => {
      const wallet = walletWith('100.00');
      const bet = processed(wagerTransaction(Bet, '25.00'));
      const refund = processed(referencing(Refund, bet));

      settle(referencing(Rollback, refund), wallet, { reference: refund });

      expect(wallet.balance.toString()).toBe('75.00');
    });

    it('cannot reference another ROLLBACK or a LOSS', () => {
      const wallet = walletWith('100.00');
      const bet = processed(wagerTransaction(Bet, '25.00'));
      const rollback = processed(referencing(Rollback, bet));
      const loss = processed(wagerTransaction(Loss, '25.00'));

      expect(settle(referencing(Rollback, rollback), wallet, { reference: rollback })).toEqual({
        status: Rejected,
        failureCode: FailureCode.ReferenceKindNotAllowed,
      });
      expect(settle(referencing(Rollback, loss), wallet, { reference: loss })).toEqual({
        status: Rejected,
        failureCode: FailureCode.ReferenceKindNotAllowed,
      });
    });

    it('that would make the balance negative is rejected with a code distinct from BET', () => {
      const wallet = walletWith('10.00'); // the player already spent the WIN
      const win = processed(wagerTransaction(Win, '30.00'));
      const rollback = referencing(Rollback, win);

      const outcome = settle(rollback, wallet, { reference: win });

      expect(outcome).toEqual({
        status: Rejected,
        failureCode: FailureCode.ReversalInsufficientFunds,
      });
      expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
      expect(rollback.referenceTransactionId).toBe(win.id);
      expect(wallet.balance.toString()).toBe('10.00');
    });
  });

  describe('references', () => {
    it('missing reference parks the transaction as PENDING_REFERENCE', () => {
      const wallet = walletWith('75.00');
      const refund = wagerTransaction(Refund, '25.00', { referenceExternalTransactionId: 'later' });

      const outcome = settle(refund, wallet, { reference: undefined });

      expect(outcome).toEqual({ status: PendingReference });
      expect(refund.status).toBe(PendingReference);
      expect(refund.referenceAttempts).toBe(1);
      expect(wallet.version).toBe(1);
    });

    it('a reference that is itself still pending keeps waiting', () => {
      const wallet = walletWith('75.00');
      const bet = wagerTransaction(Bet, '25.00'); // PENDING

      expect(settle(referencing(Refund, bet), wallet, { reference: bet }).status).toBe(
        PendingReference,
      );
    });

    it('a REJECTED reference cannot be reversed', () => {
      const wallet = walletWith('75.00');
      const bet = wagerTransaction(Bet, '25.00');
      bet.reject(FailureCode.InsufficientFunds);

      expect(settle(referencing(Refund, bet), wallet, { reference: bet })).toEqual({
        status: Rejected,
        failureCode: FailureCode.ReferenceNotProcessed,
      });
    });

    it.each([
      ['round', { roundId: 'other-round' }],
      ['player', { playerId: 'other-player' }],
      ['wallet', { walletId: 'other-wallet' }],
      ['provider', { providerId: 'provider-b' }],
    ])('reference from another %s is REFERENCE_MISMATCH', (_, override) => {
      const wallet = walletWith('75.00');
      const bet = processed(wagerTransaction(Bet, '25.00', override));

      expect(settle(referencing(Refund, bet), wallet, { reference: bet })).toEqual({
        status: Rejected,
        failureCode: FailureCode.ReferenceMismatch,
      });
    });
  });

  describe('wallet checks', () => {
    it('rejects CURRENCY_MISMATCH before touching the balance', () => {
      const wallet = walletWith('100.00');
      const bet = wagerTransaction(Bet, '10.00', {
        money: Money.from({ amount: '10.00', currency: 'USD' }),
      });

      expect(settle(bet, wallet)).toEqual({
        status: Rejected,
        failureCode: FailureCode.CurrencyMismatch,
      });
      expect(wallet.version).toBe(1);
    });

    it('rejects a transaction whose player does not own the wallet', () => {
      const wallet = walletWith('100.00');

      expect(settle(wagerTransaction(Bet, '10.00', { playerId: 'intruder' }), wallet)).toEqual({
        status: Rejected,
        failureCode: FailureCode.WalletPlayerMismatch,
      });
    });
  });
});
