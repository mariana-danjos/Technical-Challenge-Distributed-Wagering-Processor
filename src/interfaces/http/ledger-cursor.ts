import { ApiError } from './errors/api-error';

interface CursorPayload {
  v: 1;
  /** Wallet the cursor belongs to; a cursor is rejected on another wallet. */
  w: string;
  /** Last ledger sequence returned (exclusive lower bound of the next page). */
  s: string;
}

/**
 * Opaque, stable ledger cursor. Stable because a wallet's sequences are assigned under the wallet
 * lock and only grow in commit order, so a page boundary never skips or repeats an entry.
 */
export const LedgerCursor = {
  encode(walletId: string, sequence: string): string {
    const payload: CursorPayload = { v: 1, w: walletId, s: sequence };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  },

  /** @returns the sequence to continue after. */
  decode(walletId: string, cursor: string): string {
    let payload: Partial<CursorPayload>;
    try {
      payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw ApiError.validation('Invalid cursor');
    }
    if (payload?.v !== 1 || payload.w !== walletId || !/^\d{1,19}$/.test(payload.s ?? '')) {
      throw ApiError.validation('Invalid cursor');
    }
    return payload.s as string;
  },
};
