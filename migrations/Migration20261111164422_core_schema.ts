import { Migration } from '@mikro-orm/migrations';

/**
 * Core wagering schema. Financial invariants are enforced here, not only in application code:
 * - uniqueness: one wallet per (player, currency); idempotency key; (provider, external id);
 *   one ledger entry per transaction; one PROCESSED reversal per referenced transaction;
 * - non-negativity: balance and ledger balances CHECK >= 0;
 * - immutability: ledger is append-only, terminal transactions are frozen, identity columns fixed;
 * - consistency: ledger entries chain (before = previous after) and, at commit, the wallet balance
 *   must equal the last ledger balance_after (deferred constraint trigger).
 */
export class Migration20261111164422_core_schema extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- shared
    this.addSql(`
      create function forbid_modification() returns trigger language plpgsql as $$
      begin
        raise exception '% is not allowed on table %', TG_OP, TG_TABLE_NAME
          using errcode = 'integrity_constraint_violation';
      end $$;
    `);

    // ---------------------------------------------------------------- wallets
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null check (player_id <> ''),
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(19, 2) not null check (balance >= 0),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_id_currency_uq unique (id, currency)
      );
    `);

    this.addSql(`
      create function wallets_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP = 'INSERT' then
          if NEW.version <> 1 then
            raise exception 'wallet % must be created at version 1', NEW.id
              using errcode = 'check_violation';
          end if;
          return NEW;
        end if;

        if (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           is distinct from (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) then
          raise exception 'wallet % identity columns are immutable', OLD.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if NEW.balance <> OLD.balance and NEW.version <> OLD.version + 1 then
          raise exception 'wallet % version must increment by 1 when the balance changes', OLD.id
            using errcode = 'check_violation';
        end if;
        if NEW.balance = OLD.balance and NEW.version <> OLD.version then
          raise exception 'wallet % version must not change unless the balance changes', OLD.id
            using errcode = 'check_violation';
        end if;
        return NEW;
      end $$;
    `);
    this.addSql(`
      create trigger wallets_guard before insert or update on wallets
        for each row execute function wallets_guard();
    `);
    this.addSql(`
      create trigger wallets_no_delete before delete on wallets
        for each row execute function forbid_modification();
    `);

    // ---------------------------------------------------------------- wager_transactions
    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null check (provider_id <> ''),
        external_transaction_id text not null check (external_transaction_id <> ''),
        idempotency_key text not null check (idempotency_key <> ''),
        payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id uuid not null references wallets (id),
        player_id text not null check (player_id <> ''),
        round_id text not null check (round_id <> ''),
        game_id text not null check (game_id <> ''),
        kind text not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(19, 2) not null,
        currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text check (reference_external_transaction_id <> ''),
        reference_transaction_id uuid references wager_transactions (id),
        status text not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text check (failure_code ~ '^[A-Z][A-Z_]*$'),
        reference_attempts integer not null default 0 check (reference_attempts >= 0),
        next_reference_check_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,

        constraint wager_transactions_idempotency_key_uq unique (idempotency_key),
        constraint wager_transactions_provider_external_uq
          unique (provider_id, external_transaction_id),
        -- Target of the ledger's composite FK: an entry must match its transaction's
        -- wallet, currency and amount.
        constraint wager_transactions_ledger_target_uq unique (id, wallet_id, currency, amount),

        constraint wager_transactions_amount_ck
          check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_transactions_reference_required_ck
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_reference_allowed_ck
          check (kind in ('WIN', 'LOSS', 'REFUND', 'ROLLBACK')
                 or (reference_external_transaction_id is null and reference_transaction_id is null)),
        constraint wager_transactions_processed_reversal_ck
          check (status <> 'PROCESSED' or kind not in ('REFUND', 'ROLLBACK')
                 or reference_transaction_id is not null),
        constraint wager_transactions_failure_code_ck
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_transactions_processed_at_ck
          check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_transactions_pending_reference_ck
          check (status <> 'PENDING_REFERENCE' or next_reference_check_at is not null)
      );
    `);

    // A referenced transaction can be reversed (REFUND or ROLLBACK) at most once.
    this.addSql(`
      create unique index wager_transactions_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
    `);
    // Polled by the out-of-order reference worker.
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_transactions_wallet_idx on wager_transactions (wallet_id);`);

    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if OLD.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%)', OLD.id, OLD.status
            using errcode = 'integrity_constraint_violation';
        end if;
        if NEW.status = 'PENDING' and OLD.status <> 'PENDING' then
          raise exception 'wager transaction % cannot return to PENDING', OLD.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
            NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind,
            NEW.amount, NEW.currency, NEW.reference_external_transaction_id, NEW.created_at)
           is distinct from
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
            OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind,
            OLD.amount, OLD.currency, OLD.reference_external_transaction_id, OLD.created_at) then
          raise exception 'wager transaction % request columns are immutable', OLD.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return NEW;
      end $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard before update on wager_transactions
        for each row execute function wager_transactions_guard();
    `);
    this.addSql(`
      create trigger wager_transactions_no_delete before delete on wager_transactions
        for each row execute function forbid_modification();
    `);
    this.addSql(`
      create trigger wager_transactions_no_truncate before truncate on wager_transactions
        for each statement execute function forbid_modification();
    `);

    // ---------------------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        -- Assigned by the insert trigger while holding the wallet lock, so per-wallet order
        -- matches commit order and serves as a stable pagination cursor.
        sequence bigint not null,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(19, 2) not null check (amount > 0),
        currency char(3) not null,
        balance_before numeric(19, 2) not null check (balance_before >= 0),
        balance_after numeric(19, 2) not null check (balance_after >= 0),
        created_at timestamptz not null,

        constraint wallet_ledger_entries_sequence_uq unique (sequence),
        constraint wallet_ledger_entries_transaction_uq unique (transaction_id),
        constraint wallet_ledger_entries_wallet_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_fk
          foreign key (transaction_id, wallet_id, currency, amount)
          references wager_transactions (id, wallet_id, currency, amount),
        constraint wallet_ledger_entries_arithmetic_ck check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`create sequence wallet_ledger_entries_sequence_seq owned by wallet_ledger_entries.sequence;`);
    this.addSql(`
      create index wallet_ledger_entries_wallet_sequence_idx
        on wallet_ledger_entries (wallet_id, sequence);
    `);

    this.addSql(`
      create function wallet_ledger_entries_append() returns trigger language plpgsql as $$
      declare
        previous_after numeric(19, 2);
      begin
        -- Serialize appends per wallet even if the caller did not lock the wallet row.
        perform 1 from wallets where id = NEW.wallet_id for update;
        NEW.sequence := nextval('wallet_ledger_entries_sequence_seq');

        select balance_after into previous_after
          from wallet_ledger_entries
         where wallet_id = NEW.wallet_id
         order by sequence desc
         limit 1;
        if NEW.balance_before <> coalesce(previous_after, 0) then
          raise exception 'ledger entry for wallet % starts at % but previous balance_after is %',
            NEW.wallet_id, NEW.balance_before, coalesce(previous_after, 0)
            using errcode = 'check_violation';
        end if;
        return NEW;
      end $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_append before insert on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_append();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable before update or delete on wallet_ledger_entries
        for each row execute function forbid_modification();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function forbid_modification();
    `);

    // ---------------------------------------------------------------- balance ↔ ledger consistency
    this.addSql(`
      create function check_wallet_ledger_consistency() returns trigger language plpgsql as $$
      declare
        target_wallet uuid;
        stored_balance numeric(19, 2);
        ledger_balance numeric(19, 2);
      begin
        if TG_TABLE_NAME = 'wallets' then
          target_wallet := NEW.id;
        else
          target_wallet := NEW.wallet_id;
        end if;

        select balance into stored_balance from wallets where id = target_wallet;
        select coalesce(
                 (select balance_after from wallet_ledger_entries
                   where wallet_id = target_wallet order by sequence desc limit 1),
                 0)
          into ledger_balance;

        if stored_balance is distinct from ledger_balance then
          raise exception 'wallet % balance % diverges from ledger balance %',
            target_wallet, stored_balance, ledger_balance
            using errcode = 'check_violation';
        end if;
        return null;
      end $$;
    `);
    this.addSql(`
      create constraint trigger wallets_ledger_consistency
        after insert or update of balance on wallets
        deferrable initially deferred
        for each row execute function check_wallet_ledger_consistency();
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_consistency
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function check_wallet_ledger_consistency();
    `);

    // ---------------------------------------------------------------- inbox
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null check (consumer_name <> ''),
        message_id text not null check (message_id <> ''),
        payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      );
    `);

    // ---------------------------------------------------------------- outbox
    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null check (event_type <> ''),
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz not null,
        published_at timestamptz
      );
    `);
    // Polled by outbox publishers (claimed with FOR UPDATE SKIP LOCKED).
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at)
        where published_at is null;
    `);

    this.addSql(`
      create function outbox_messages_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP = 'DELETE' then
          if OLD.published_at is null then
            raise exception 'outbox message % is unpublished and cannot be deleted', OLD.id
              using errcode = 'integrity_constraint_violation';
          end if;
          return OLD;
        end if;

        if (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
           is distinct from (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) then
          raise exception 'outbox message % event columns are immutable', OLD.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if OLD.published_at is not null and NEW.published_at is distinct from OLD.published_at then
          raise exception 'outbox message % is already published', OLD.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return NEW;
      end $$;
    `);
    this.addSql(`
      create trigger outbox_messages_guard before update or delete on outbox_messages
        for each row execute function outbox_messages_guard();
    `);
  }

  override async down(): Promise<void> {
    // Tables first (dropping them drops their triggers), then the trigger functions.
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(`drop function if exists outbox_messages_guard();`);
    this.addSql(`drop function if exists check_wallet_ledger_consistency();`);
    this.addSql(`drop function if exists wallet_ledger_entries_append();`);
    this.addSql(`drop function if exists wager_transactions_guard();`);
    this.addSql(`drop function if exists wallets_guard();`);
    this.addSql(`drop function if exists forbid_modification();`);
  }
}
