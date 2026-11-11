export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {}

export class InvalidWalletError extends DomainError {}

export class InvalidLedgerEntryError extends DomainError {}

export class InvalidWagerTransactionError extends DomainError {}

/** Raised when code tries an illegal state transition — a programming error, not a business path. */
export class InvalidTransactionStateError extends DomainError {}
