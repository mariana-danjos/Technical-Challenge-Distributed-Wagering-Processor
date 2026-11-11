import { Money } from '../../src/domain/money/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';

export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const WALLET_ID = 'wallet-1';
export const PLAYER_ID = 'player-1';
export const PROVIDER_ID = 'provider-a';
export const ROUND_ID = 'round-987';

let sequence = 0;
export function nextId(prefix = 'id'): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

export function walletWith(balance: string, overrides: { currency?: string } = {}): Wallet {
  return Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: Money.from({ amount: balance, currency: overrides.currency ?? 'BRL' }),
    openingTransactionId: nextId('opening'),
    openingEntryId: nextId('entry'),
    at: NOW,
  }).wallet;
}

export function wagerTransaction(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.create({
    id: nextId('tx'),
    providerId: PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${overrides.providerId ?? PROVIDER_ID}:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    at: NOW,
    ...overrides,
  });
}

/** A transaction already PROCESSED, e.g. a reference that was applied earlier. */
export function processed(transaction: WagerTransaction): WagerTransaction {
  transaction.markProcessed(undefined, NOW);
  return transaction;
}
