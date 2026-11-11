import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../shared/domain-error';

export const MONEY_SCALE = 2;

/** Matches numeric(19,2): at most 17 integer digits. */
const MAX_INTEGER_DIGITS = 17;
const AMOUNT_PATTERN = new RegExp(`^\\d{1,${MAX_INTEGER_DIGITS}}(\\.\\d{1,${MONEY_SCALE}})?$`);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Parses an input contract amount: a non-negative decimal string with up to 2 decimal places
   * ("25", "25.5", "25.00"). Rejects NaN, Infinity, scientific notation, signs and empty strings.
   */
  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Invalid amount: "${String(props.amount)}"`);
    }
    return new Money(new Decimal(props.amount), Money.parseCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    // Avoid producing -0, which would serialize as "-0.00".
    return this.isZero() ? this : new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Decimal string with fixed scale 2, e.g. "25.00". */
  toString(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency: "${String(currency)}"`);
    }
    return currency;
  }
}
