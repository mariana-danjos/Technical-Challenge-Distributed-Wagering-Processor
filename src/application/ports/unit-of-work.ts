import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface StoredWagerTransaction {
  transaction: WagerTransaction;
  /** Wallet balance observed when the transaction was decided, in the wallet's currency. */
  observedBalance: Money | undefined;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT … FOR UPDATE: holds the wallet row lock until the unit of work ends. */
  lockById(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /** Persists balance/version, guarded by the version read under the lock. */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface DuplicateLookup {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
}

export interface WagerTransactionRepository {
  /**
   * Transactions sharing the idempotency key or the (provider, external id) pair, read in ONE
   * statement: separate queries could straddle a concurrent commit and misreport a replay as a
   * conflict.
   */
  findDuplicates(lookup: DuplicateLookup): Promise<StoredWagerTransaction[]>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND/ROLLBACK already reverses the given transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction, observedBalance: Money): Promise<void>;
}

export interface LedgerSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Stored balance and ledger-rebuilt balance read in a single statement (same snapshot). */
  snapshot(walletId: string): Promise<LedgerSnapshot | undefined>;
}

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
}

/**
 * Runs `work` in one SQL transaction: everything it writes commits together or not at all.
 * Infrastructure failures are translated to the errors in `application/errors.ts`.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
