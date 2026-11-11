import { LedgerDirection, invertDirection } from '../ledger/wallet-ledger-entry';
import type { Money } from '../money/money';
import { addMilliseconds, exponentialBackoffDelay, type BackoffPolicy } from '../shared/backoff';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../shared/domain-error';
import type { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING', // internal: wallet opening credit
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // accepted, not applied yet
  PendingReference = 'PENDING_REFERENCE', // waiting for the referenced transaction
  Processed = 'PROCESSED', // applied (terminal)
  Rejected = 'REJECTED', // business rule violation (terminal)
  Failed = 'FAILED', // permanent infrastructure error (terminal, auditable)
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Which kinds each kind may reference. Kinds absent from the map cannot carry a reference. */
const ALLOWED_REFERENCE_KINDS: ReadonlyMap<WagerTransactionKind, ReadonlySet<WagerTransactionKind>> =
  new Map([
    [WagerTransactionKind.Win, new Set([WagerTransactionKind.Bet])],
    [WagerTransactionKind.Loss, new Set([WagerTransactionKind.Bet])],
    [WagerTransactionKind.Refund, new Set([WagerTransactionKind.Bet])],
    [
      WagerTransactionKind.Rollback,
      new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]),
    ],
  ]);

/** Out-of-order references: retry ~1s, 2s, 4s… capped at 5 min, 10 attempts (~13.5 min total). */
export const REFERENCE_RETRY_POLICY: BackoffPolicy & { maxAttempts: number } = {
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  maxAttempts: 10,
};

export const OPENING_PROVIDER_ID = 'internal';

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  referenceAttempts: number;
  nextReferenceCheckAt: Date | undefined;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  at: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  at: Date;
}

/**
 * Valid transitions:
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (retry rescheduled)
 *   PROCESSED, REJECTED, FAILED are terminal.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
  ) {}

  /** Entry point for provider-submitted transactions. Born PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING transactions cannot be submitted');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError(`Unknown transaction kind: ${String(props.kind)}`);
    }
    for (const field of [
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const) {
      if (!props[field]) {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }
    const reference = props.referenceExternalTransactionId || undefined;
    const allowedReferences = ALLOWED_REFERENCE_KINDS.get(props.kind);
    if (reference !== undefined && allowedReferences === undefined) {
      throw new InvalidWagerTransactionError(`${props.kind} cannot reference another transaction`);
    }
    if (reference === undefined && isReversal(props.kind)) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('Amount must not be negative');
    }
    if (props.money.isZero() && props.kind !== WagerTransactionKind.Loss) {
      throw new InvalidWagerTransactionError(`${props.kind} amount must be positive`);
    }

    return WagerTransaction.newPending({ ...props, referenceExternalTransactionId: reference });
  }

  /** Internal credit backing a wallet's initial balance. Born PROCESSED. */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('OPENING amount must be positive');
    }
    const transaction = WagerTransaction.newPending({
      id: props.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `${OPENING_PROVIDER_ID}:opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: OPENING_PROVIDER_ID,
      gameId: OPENING_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      at: props.at,
    });
    transaction.markProcessed(undefined, props.at);
    return transaction;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.referenceAttempts,
      state.nextReferenceCheckAt,
    );
  }

  private static newPending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.at,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transitions (throw InvalidTransactionStateError from a terminal state)

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  /** Parks the transaction until its reference shows up; schedules the next check with backoff. */
  markPendingReference(now: Date): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = addMilliseconds(
      now,
      exponentialBackoffDelay(this._referenceAttempts, REFERENCE_RETRY_POLICY),
    );
  }

  reject(code: FailureCode, referenceTransactionId?: string): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._referenceTransactionId = referenceTransactionId;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** True for REFUND and ROLLBACK. WIN/LOSS may carry an optional reference. */
  requiresReference(): boolean {
    return isReversal(this.kind);
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  canReference(kind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCE_KINDS.get(this.kind)?.has(kind) ?? false;
  }

  hasExhaustedReferenceAttempts(): boolean {
    return this._referenceAttempts >= REFERENCE_RETRY_POLICY.maxAttempts;
  }

  /** Same idempotency key with a different hash is a conflict, not a replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK direction depends on its reference');
        }
        return invertDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not move the balance');
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${action} transaction ${this.id}: status ${this._status} is terminal`,
      );
    }
  }
}

function isReversal(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}
