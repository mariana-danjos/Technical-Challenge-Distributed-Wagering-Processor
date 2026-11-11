import { Migration } from '@mikro-orm/migrations';

/**
 * Wallet balance observed when the transaction was decided (in the wallet's currency). Replays
 * return it as the original response, including for LOSS/REJECTED, which have no ledger entry.
 */
export class Migration20261111165838_observed_balance extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column observed_balance numeric(19, 2) check (observed_balance >= 0);
    `);
    // NOT VALID: enforced for new and updated rows; pre-existing rows cannot be backfilled
    // because terminal transactions are frozen by trigger.
    this.addSql(`
      alter table wager_transactions
        add constraint wager_transactions_observed_balance_ck
        check (status in ('PENDING', 'FAILED') or observed_balance is not null) not valid;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        drop constraint if exists wager_transactions_observed_balance_ck,
        drop column if exists observed_balance;
    `);
  }
}
