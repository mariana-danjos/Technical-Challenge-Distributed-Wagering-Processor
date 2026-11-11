import { describe, expect, it } from 'bun:test';
import { WalletBalanceChanged, WagerTransactionRejected } from '../../../src/domain/events/wagering-events';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { OUTBOX_RETRY_POLICY, OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { InvalidTransactionStateError } from '../../../src/domain/shared/domain-error';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction';
import { NOW, brl, wagerTransaction, walletWith } from '../../support/domain-fixtures';

const ctx = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-123', occurredAt: NOW };

function balanceChangedEvent() {
  const wallet = walletWith('100.00');
  const entry = wallet.debit({ transactionId: 'tx-1', entryId: 'e-1', money: brl('25.00'), at: NOW });
  return WalletBalanceChanged.from(wallet, entry, ctx);
}

describe('IntegrationEvent', () => {
  it('serializes a stable, versioned envelope with MoneyProps strings', () => {
    const envelope = JSON.parse(JSON.stringify(balanceChangedEvent()));

    expect(envelope).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-123',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('keeps event type and version on the type and freezes data', () => {
    const transaction = wagerTransaction(WagerTransactionKind.Bet, '10.00');
    transaction.reject(FailureCode.InsufficientFunds);
    const event = WagerTransactionRejected.from(transaction, ctx);

    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.version).toBe(1);
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe('OutboxMessage', () => {
  it('enqueues the serialized envelope, due immediately, keyed by event id', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    expect(message.id).toBe('evt-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload.eventType).toBe('WalletBalanceChanged');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
  });

  it('schedules retries with exponential backoff, capped', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    message.scheduleRetry(NOW);
    expect(message.attempts).toBe(1);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(new Date(NOW.getTime() + 1_000))).toBe(true);

    message.scheduleRetry(NOW);
    expect(message.nextAttemptAt.getTime() - NOW.getTime()).toBe(2_000);

    for (let i = 0; i < 20; i++) message.scheduleRetry(NOW);
    expect(message.nextAttemptAt.getTime() - NOW.getTime()).toBe(OUTBOX_RETRY_POLICY.maxDelayMs);
  });

  it('is no longer pending or retryable once published', () => {
    const message = OutboxMessage.enqueue(balanceChangedEvent());

    message.markPublished(NOW);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);
    expect(() => message.markPublished(NOW)).toThrow(InvalidTransactionStateError);
    expect(() => message.scheduleRetry(NOW)).toThrow(InvalidTransactionStateError);
  });
});

describe('InboxMessage', () => {
  it('is received unprocessed and can be processed exactly once', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'wager-transactions',
      payloadHash: 'a'.repeat(64),
      receivedAt: NOW,
    });

    expect(message.isProcessed()).toBe(false);
    message.markProcessed(NOW);
    expect(message.processedAt).toEqual(NOW);
    expect(() => message.markProcessed(NOW)).toThrow(InvalidTransactionStateError);
  });
});
