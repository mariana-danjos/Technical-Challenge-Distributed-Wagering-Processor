import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../src/domain/shared/domain-error';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import {
  REFERENCE_RETRY_POLICY,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction';
import { NOW, brl, processed, wagerTransaction } from '../../support/domain-fixtures';

const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;

describe('WagerTransaction', () => {
  describe('create', () => {
    it('is born PENDING', () => {
      const transaction = wagerTransaction(Bet, '25.00');

      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(transaction.isTerminal()).toBe(false);
      expect(transaction.referenceAttempts).toBe(0);
    });

    it('refuses OPENING from external input', () => {
      expect(() => wagerTransaction(Opening, '10.00')).toThrow(InvalidWagerTransactionError);
    });

    it.each([Refund, Rollback])('%s requires referenceExternalTransactionId', (kind) => {
      expect(() => wagerTransaction(kind, '10.00')).toThrow(InvalidWagerTransactionError);
      expect(() =>
        wagerTransaction(kind, '10.00', { referenceExternalTransactionId: '' }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('BET cannot carry a reference', () => {
      expect(() =>
        wagerTransaction(Bet, '10.00', { referenceExternalTransactionId: 'other' }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it.each([Win, Loss])('%s accepts an optional reference', (kind) => {
      expect(wagerTransaction(kind, '10.00').hasReference()).toBe(false);
      expect(
        wagerTransaction(kind, '10.00', { referenceExternalTransactionId: 'bet-1' }).hasReference(),
      ).toBe(true);
    });

    it.each([Bet, Win, Refund, Rollback])('%s rejects zero amounts', (kind) => {
      expect(() =>
        wagerTransaction(kind, '0.00', { referenceExternalTransactionId: 'ref' }),
      ).toThrow(InvalidWagerTransactionError);
    });

    it('LOSS accepts a zero amount', () => {
      expect(wagerTransaction(Loss, '0.00').money.isZero()).toBe(true);
    });

    it('rejects unknown kinds and missing identifiers', () => {
      expect(() => wagerTransaction('JACKPOT' as WagerTransactionKind, '1.00')).toThrow(
        InvalidWagerTransactionError,
      );
      expect(() => wagerTransaction(Bet, '1.00', { roundId: '' })).toThrow(
        InvalidWagerTransactionError,
      );
    });
  });

  describe('createOpening', () => {
    it('is internal and already PROCESSED', () => {
      const opening = WagerTransaction.createOpening({
        id: 'opening-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('1000.00'),
        payloadHash: 'b'.repeat(64),
        at: NOW,
      });

      expect(opening.kind).toBe(Opening);
      expect(opening.status).toBe(WagerTransactionStatus.Processed);
      expect(opening.providerId).toBe('internal');
      expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
  });

  describe('state machine', () => {
    const terminalize: Record<string, (t: WagerTransaction) => void> = {
      PROCESSED: (t) => t.markProcessed(undefined, NOW),
      REJECTED: (t) => t.reject(FailureCode.InsufficientFunds),
      FAILED: (t) => t.fail(FailureCode.InternalError),
    };

    it.each(Object.keys(terminalize))('%s is terminal: every further transition throws', (status) => {
      const transaction = wagerTransaction(Bet, '10.00');
      terminalize[status]!(transaction);

      expect(transaction.status).toBe(status as WagerTransactionStatus);
      expect(transaction.isTerminal()).toBe(true);
      for (const transition of Object.values(terminalize)) {
        expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
      }
      expect(() => transaction.markPendingReference(NOW)).toThrow(InvalidTransactionStateError);
    });

    it('PENDING_REFERENCE can be rescheduled and then processed', () => {
      const transaction = wagerTransaction(Refund, '10.00', {
        referenceExternalTransactionId: 'bet-1',
      });

      transaction.markPendingReference(NOW);
      transaction.markPendingReference(NOW);
      transaction.markProcessed('bet-internal-id', NOW);

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.referenceTransactionId).toBe('bet-internal-id');
      expect(transaction.processedAt).toEqual(NOW);
    });

    it('reference retries back off exponentially up to the cap and budget', () => {
      const transaction = wagerTransaction(Refund, '10.00', {
        referenceExternalTransactionId: 'bet-1',
      });
      const delays: number[] = [];

      for (let i = 0; i < REFERENCE_RETRY_POLICY.maxAttempts; i++) {
        expect(transaction.hasExhaustedReferenceAttempts()).toBe(false);
        transaction.markPendingReference(NOW);
        delays.push(transaction.nextReferenceCheckAt!.getTime() - NOW.getTime());
      }

      expect(delays.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
      expect(Math.max(...delays)).toBe(REFERENCE_RETRY_POLICY.maxDelayMs);
      expect(transaction.hasExhaustedReferenceAttempts()).toBe(true);
    });

    it('records the failure code on reject and fail', () => {
      const rejected = wagerTransaction(Bet, '10.00');
      rejected.reject(FailureCode.InsufficientFunds);

      expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(rejected.processedAt).toBeUndefined();
    });
  });

  describe('queries', () => {
    it('matchesPayload: same idempotency key with a divergent payload hash is not a replay', () => {
      const transaction = wagerTransaction(Bet, '10.00', { payloadHash: 'a'.repeat(64) });

      expect(transaction.matchesPayload('a'.repeat(64))).toBe(true);
      expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
    });

    it('affectsBalance is false only for LOSS', () => {
      expect(wagerTransaction(Loss, '0.00').affectsBalance()).toBe(false);
      expect(wagerTransaction(Bet, '1.00').affectsBalance()).toBe(true);
    });

    it('requiresReference is true only for REFUND and ROLLBACK', () => {
      expect(wagerTransaction(Win, '1.00').requiresReference()).toBe(false);
      expect(
        wagerTransaction(Refund, '1.00', { referenceExternalTransactionId: 'r' }).requiresReference(),
      ).toBe(true);
    });

    it('ledgerDirectionFor: ROLLBACK inverts the direction of its reference', () => {
      const rollback = wagerTransaction(Rollback, '10.00', { referenceExternalTransactionId: 'r' });
      const bet = processed(wagerTransaction(Bet, '10.00'));
      const win = processed(wagerTransaction(Win, '10.00'));
      const refund = processed(
        wagerTransaction(Refund, '10.00', { referenceExternalTransactionId: 'r' }),
      );

      expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
      expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
      expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
      expect(() => wagerTransaction(Loss, '1.00').ledgerDirectionFor()).toThrow(
        InvalidWagerTransactionError,
      );
    });
  });
});
