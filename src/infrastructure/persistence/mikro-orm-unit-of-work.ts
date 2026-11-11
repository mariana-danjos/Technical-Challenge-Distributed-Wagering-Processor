import {
  ConnectionException,
  DeadlockException,
  DriverException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  TransientInfrastructureError,
  Uniqueness,
  UniquenessViolationError,
} from '../../application/errors';
import type { Repositories, UnitOfWork } from '../../application/ports/unit-of-work';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './mikro-orm-repositories';

export interface UnitOfWorkOptions {
  /** Max wait for a row lock before failing transiently (hot-wallet back-pressure). */
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  /**
   * Max time the transaction may sit idle between statements (e.g. while the outbox relay talks to
   * SQS); PostgreSQL then ends the session so locks are never held by a stuck process.
   */
  idleInTransactionTimeoutMs: number;
}

const DEFAULT_OPTIONS: UnitOfWorkOptions = {
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 30_000,
};

const UNIQUE_CONSTRAINTS: Record<string, Uniqueness> = {
  wallets_player_currency_uq: Uniqueness.WalletPlayerCurrency,
  wager_transactions_idempotency_key_uq: Uniqueness.WagerIdempotencyKey,
  wager_transactions_provider_external_uq: Uniqueness.WagerExternalId,
  inbox_messages_pk: Uniqueness.InboxMessage,
};

/** SQLSTATEs worth retrying: serialization failure, statement timeout, admin shutdown, etc. */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03', '25P03']);
/** Whole classes: 08 connection exceptions, 53 insufficient resources (e.g. too_many_connections). */
const TRANSIENT_SQLSTATE_CLASSES = ['08', '53'];
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/**
 * One SQL transaction per `run`, at READ COMMITTED: correctness comes from the wallet row lock
 * plus the schema constraints, not from the isolation level.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly options: UnitOfWorkOptions;

  constructor(
    private readonly orm: MikroORM,
    options: Partial<UnitOfWorkOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(
          `set local lock_timeout = ${Math.trunc(this.options.lockTimeoutMs)};
           set local statement_timeout = ${Math.trunc(this.options.statementTimeoutMs)};
           set local idle_in_transaction_session_timeout = ${Math.trunc(this.options.idleInTransactionTimeoutMs)}`,
        );
        return work(repositoriesFor(em));
      });
    } catch (error) {
      throw translate(error);
    }
  }
}

function isTransientSqlState(code: string | undefined): boolean {
  if (!code) return false;
  return TRANSIENT_SQLSTATES.has(code) || TRANSIENT_SQLSTATE_CLASSES.some((cls) => code.startsWith(cls));
}

function repositoriesFor(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

function translate(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    const constraint = Object.keys(UNIQUE_CONSTRAINTS).find((name) => error.message.includes(name));
    return new UniquenessViolationError(
      constraint ? UNIQUE_CONSTRAINTS[constraint]! : Uniqueness.Other,
      { cause: error },
    );
  }
  if (
    error instanceof LockWaitTimeoutException ||
    error instanceof DeadlockException ||
    error instanceof ConnectionException ||
    (error instanceof DriverException && isTransientSqlState(error.code))
  ) {
    return new TransientInfrastructureError('Database temporarily unavailable', { cause: error });
  }
  const { code, name } = error as { code?: string; name?: string };
  if (name === 'KnexTimeoutError' || TRANSIENT_NODE_CODES.has(code ?? '')) {
    return new TransientInfrastructureError('Database connection unavailable', { cause: error });
  }
  return error;
}
