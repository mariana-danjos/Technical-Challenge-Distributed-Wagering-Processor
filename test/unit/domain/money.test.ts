import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/shared/domain-error';
import { brl } from '../../support/domain-fixtures';

describe('Money', () => {
  describe('parsing and scale', () => {
    it.each([
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['25.00', '25.00'],
      ['0', '0.00'],
      ['0.01', '0.01'],
      ['007.10', '7.10'],
      ['99999999999999999.99', '99999999999999999.99'],
    ])('parses %p and serializes with fixed scale 2 as %p', (amount, expected) => {
      expect(brl(amount).toString()).toBe(expected);
    });

    it.each([
      'NaN',
      'Infinity',
      '-Infinity',
      '1e3',
      '1E3',
      '',
      ' ',
      ' 10.00',
      '10.001',
      '0.005',
      '-1.00',
      '+1.00',
      '1,00',
      '.50',
      '10.',
      '0x10',
      '123456789012345678.00',
    ])('rejects invalid amount %p', (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it('rejects non-string amounts', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    it.each(['', 'brl', 'BR', 'BRLX', '123'])('rejects invalid currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });

    it('serializes toJSON as decimal-string props', () => {
      expect(JSON.parse(JSON.stringify(brl('25')))).toEqual({ amount: '25.00', currency: 'BRL' });
    });
  });

  describe('arithmetic', () => {
    it('is exact where binary floating point is not', () => {
      expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
      expect(brl('1000000000000000.01').add(brl('0.02')).toString()).toBe('1000000000000000.03');
    });

    it('is immutable', () => {
      const a = brl('10.00');
      const b = a.add(brl('5.00'));

      expect(a.toString()).toBe('10.00');
      expect(b.toString()).toBe('15.00');
      expect(b).not.toBe(a);
    });

    it('supports subtract and negate, allowing negative intermediate values', () => {
      const negative = brl('10.00').subtract(brl('25.50'));

      expect(negative.toString()).toBe('-15.50');
      expect(negative.isNegative()).toBe(true);
      expect(negative.negate().toString()).toBe('15.50');
    });

    it('never produces negative zero', () => {
      expect(Money.zero('BRL').negate().toString()).toBe('0.00');
      expect(brl('5.00').subtract(brl('5.00')).toString()).toBe('0.00');
    });

    it('answers sign and comparison queries', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').isNegative()).toBe(false);
      expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
      expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
      expect(brl('10').equals(brl('10.00'))).toBe(true);
    });
  });

  describe('currency conflicts', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    it.each([
      ['add', () => brl('1.00').add(usd)],
      ['subtract', () => brl('1.00').subtract(usd)],
      ['isLessThan', () => brl('1.00').isLessThan(usd)],
    ])('%s throws CurrencyMismatchError', (_, operation) => {
      expect(operation).toThrow(CurrencyMismatchError);
    });

    it('equals is false across currencies instead of throwing', () => {
      expect(brl('1.00').equals(usd)).toBe(false);
    });
  });
});
