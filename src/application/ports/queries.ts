import type { MoneyProps } from '../../domain/money/money';
import type { WalletView } from '../wallets/open-wallet';

export const WAGERING_QUERIES = Symbol('WAGERING_QUERIES');

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  /** Wallet balance observed when the transaction was decided. */
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export interface LedgerEntryView {
  entryId: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
  /** Per-wallet, commit-ordered position; the basis of the pagination cursor. */
  sequence: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  hasMore: boolean;
}

/** Read side used by the HTTP query endpoints. No locks; plain committed reads. */
export interface WageringQueries {
  wallet(walletId: string): Promise<WalletView | undefined>;
  transaction(transactionId: string): Promise<TransactionView | undefined>;
  transactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView | undefined>;
  /** Entries after `afterSequence` (exclusive), oldest first; undefined when the wallet is unknown. */
  ledger(
    walletId: string,
    page: { afterSequence: string | undefined; limit: number },
  ): Promise<LedgerPage | undefined>;
}
