import { WalletBalanceChanged } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { Uniqueness, UniquenessViolationError } from '../errors';
import { payloadHash } from '../idempotency/payload-hash';
import type { Clock, IdGenerator } from '../ports/system';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export type OpenWalletResult =
  | { outcome: 'OPENED'; wallet: WalletView }
  | { outcome: 'ALREADY_EXISTS' };

/**
 * Opens a wallet. A positive initial balance is backed by an internal OPENING transaction and its
 * CREDIT ledger entry, written in the same SQL transaction as the wallet.
 */
export class OpenWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.clock.now();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: this.ids.next(),
      at,
    });

    try {
      await this.unitOfWork.run(async (repositories) => {
        await repositories.wallets.insert(wallet);
        if (openingEntry) {
          const opening = WagerTransaction.createOpening({
            id: openingTransactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialBalance,
            payloadHash: payloadHash({
              playerId: command.playerId,
              initialBalance: initialBalance.toJSON(),
            }),
            at,
          });
          await repositories.transactions.insert(opening, wallet.balance);
          await repositories.ledger.append(openingEntry);
          await repositories.outbox.enqueue([
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, {
                eventId: this.ids.next(),
                correlationId: command.correlationId,
                occurredAt: at,
              }),
            ),
          ]);
        }
      });
    } catch (error) {
      if (
        error instanceof UniquenessViolationError &&
        error.uniqueness === Uniqueness.WalletPlayerCurrency
      ) {
        return { outcome: 'ALREADY_EXISTS' };
      }
      throw error;
    }

    return { outcome: 'OPENED', wallet: toWalletView(wallet) };
  }
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}
