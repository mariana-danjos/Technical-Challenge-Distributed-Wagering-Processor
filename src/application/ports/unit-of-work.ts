import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
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
  /**
   * Persists the mutable state of an existing transaction (status, reference, retries…).
   * `observedBalance` is left unchanged when omitted.
   */
  update(transaction: WagerTransaction, observedBalance?: Money): Promise<void>;
  /**
   * Claims one PENDING_REFERENCE transaction due at `now` (FOR NO KEY UPDATE SKIP LOCKED), so
   * concurrent resolvers never pick the same row.
   */
  claimDuePendingReference(now: Date): Promise<StoredWagerTransaction | undefined>;
  /** Locks one specific PENDING_REFERENCE transaction (SKIP LOCKED); undefined if taken or settled. */
  lockPendingReference(transactionId: string): Promise<StoredWagerTransaction | undefined>;
  /**
   * Makes PENDING_REFERENCE transactions waiting for (providerId, externalTransactionId) due now.
   * Rows currently claimed by a resolver are skipped (it is already on them).
   */
  wakePendingReferences(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}

export interface InboxRepository {
  insert(message: InboxMessage): Promise<void>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
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
  /** Claims up to `limit` due messages (FOR UPDATE SKIP LOCKED) for the rest of the unit of work. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Persists attempts / nextAttemptAt / publishedAt. */
  update(message: OutboxMessage): Promise<void>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Runs `work` in one SQL transaction: everything it writes commits together or not at all.
 * Infrastructure failures are translated to the errors in `application/errors.ts`.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
