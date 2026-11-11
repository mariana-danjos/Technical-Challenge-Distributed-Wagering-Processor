import { describe, expect, it } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../src/domain/money/money';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
} from '../../../src/domain/shared/domain-error';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { NOW, PLAYER_ID, WALLET_ID, brl, walletWith } from '../../support/domain-fixtures';

const LATER = new Date('2026-07-29T15:00:05.000Z');

function movement(amount: string) {
  return { transactionId: 'tx-1', entryId: 'entry-1', money: brl(amount), at: LATER };
}

describe('Wallet', () => {
  describe('open', () => {
    it('starts at version 1 with an OPENING credit entry for a positive initial balance', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: WALLET_ID,
        playerId: PLAYER_ID,
        initialBalance: brl('1000.00'),
        openingTransactionId: 'opening-tx',
        openingEntryId: 'opening-entry',
        at: NOW,
      });

      expect(wallet.version).toBe(1);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toString()).toBe('1000.00');
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
      expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
      expect(openingEntry?.transactionId).toBe('opening-tx');
    });

    it('produces no ledger entry for a zero initial balance', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: WALLET_ID,
        playerId: PLAYER_ID,
        initialBalance: Money.zero('BRL'),
        openingTransactionId: 'opening-tx',
        openingEntryId: 'opening-entry',
        at: NOW,
      });

      expect(wallet.balance.isZero()).toBe(true);
      expect(openingEntry).toBeUndefined();
    });

    it('rejects a negative initial balance', () => {
      expect(() =>
        Wallet.open({
          id: WALLET_ID,
          playerId: PLAYER_ID,
          initialBalance: brl('0.00').subtract(brl('1.00')),
          openingTransactionId: 'opening-tx',
          openingEntryId: 'opening-entry',
          at: NOW,
        }),
      ).toThrow(InvalidMoneyError);
    });
  });

  describe('debit and credit', () => {
    it('debits, returns a balanced entry and bumps version once', () => {
      const wallet = walletWith('100.00');

      const entry = wallet.debit(movement('80.00'));

      expect(wallet.balance.toString()).toBe('20.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(LATER);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.toString()).toBe('100.00');
      expect(entry.balanceAfter.toString()).toBe('20.00');
      expect(entry.isBalanced()).toBe(true);
    });

    it('credits and bumps version', () => {
      const wallet = walletWith('20.00');

      const entry = wallet.credit(movement('5.50'));

      expect(wallet.balance.toString()).toBe('25.50');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
    });

    it('allows debiting the whole balance down to zero', () => {
      const wallet = walletWith('100.00');

      wallet.debit(movement('100.00'));

      expect(wallet.balance.toString()).toBe('0.00');
    });

    it('never goes negative and leaves state untouched on insufficient funds', () => {
      const wallet = walletWith('100.00');

      expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(NOW);
    });

    it('rejects movements in another currency without changing state', () => {
      const wallet = walletWith('100.00');
      const usd = { ...movement('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };

      expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
      expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
    });

    it('rejects zero-amount movements, so version only moves with the balance', () => {
      const wallet = walletWith('100.00');

      expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidMoneyError);
      expect(wallet.version).toBe(1);
    });
  });

  it('rehydrates persisted state as-is', () => {
    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'BRL',
      balance: brl('975.00'),
      version: 7,
      createdAt: NOW,
      updatedAt: LATER,
    });

    expect(wallet.balance.toString()).toBe('975.00');
    expect(wallet.version).toBe(7);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'entry-1',
    walletId: WALLET_ID,
    transactionId: 'tx-1',
    createdAt: NOW,
  };

  it('accepts balanced credit and debit entries', () => {
    const credit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('5.00'),
      balanceAfter: brl('15.00'),
    });
    const debit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('10.00'),
      balanceBefore: brl('15.00'),
      balanceAfter: brl('5.00'),
    });

    expect(credit.isBalanced()).toBe(true);
    expect(debit.isBalanced()).toBe(true);
  });

  it('rejects unbalanced arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('15.00'),
        balanceAfter: brl('6.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects zero amounts and negative balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('10.00'),
    });
    const prototype = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));

    expect(prototype.sort()).toEqual(['constructor', 'isBalanced']);
  });
});
