import { Migration } from '@mikro-orm/migrations';

/**
 * Per-wallet event order. Outbox rows are inserted while the wallet row lock is held, so an
 * identity assigned at insert grows in commit order for each aggregate. The relay publishes an
 * aggregate's events strictly in `sequence` order (head of line), and the value travels in the
 * envelope so consumers can detect gaps.
 */
export class Migration20261111180628_outbox_sequence extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table outbox_messages add column sequence bigint generated always as identity;`);
    this.addSql(`alter table outbox_messages add constraint outbox_messages_sequence_uq unique (sequence);`);
    this.addSql(`drop index if exists outbox_messages_pending_idx;`);
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (sequence)
        where published_at is null;
    `);
    // Head-of-line lookup: the oldest unpublished events of an aggregate.
    this.addSql(`
      create index outbox_messages_pending_aggregate_idx
        on outbox_messages (aggregate_id, sequence)
        where published_at is null;
    `);
    // The guard freezes event columns; sequence is one of them.
    this.addSql(`
      create or replace function outbox_messages_guard() returns trigger language plpgsql as $$
      begin
        if TG_OP = 'DELETE' then
          if OLD.published_at is null then
            raise exception 'outbox message % is unpublished and cannot be deleted', OLD.id
              using errcode = 'integrity_constraint_violation';
          end if;
          return OLD;
        end if;

        if (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at, NEW.sequence)
           is distinct from
           (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at, OLD.sequence) then
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
  }

  override async down(): Promise<void> {
    this.addSql(`
      create or replace function outbox_messages_guard() returns trigger language plpgsql as $$
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
    this.addSql(`drop index if exists outbox_messages_pending_aggregate_idx;`);
    this.addSql(`drop index if exists outbox_messages_pending_idx;`);
    this.addSql(`alter table outbox_messages drop column if exists sequence;`);
    this.addSql(`
      create index outbox_messages_pending_idx
        on outbox_messages (next_attempt_at)
        where published_at is null;
    `);
  }
}
