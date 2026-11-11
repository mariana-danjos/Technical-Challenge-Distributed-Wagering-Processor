// Requires `docker compose up -d postgres`. Out-of-order references (§7.1) against real PostgreSQL.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type {
  Repositories,
  UnitOfWork,
  WagerTransactionRepository,
} from '../../src/application/ports/unit-of-work';
import { ResolvePendingReferences } from '../../src/application/wagering/resolve-pending-references';
import type { WalletView } from '../../src/application/wallets/open-wallet';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { REFERENCE_RETRY_POLICY } from '../../src/domain/wagering/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system/system-adapters';
import {
  createWageringHarness,
  expectLedgerConsistent,
  openTestWallet,
  wagerCommand,
  type WageringHarness,
} from '../support/wagering-harness';

let harness: WageringHarness;
let resolver: ResolvePendingReferences;

beforeAll(async () => {
  harness = await createWageringHarness();
  resolver = new ResolvePendingReferences(
    new MikroOrmUnitOfWork(harness.orm),
    new SystemClock(),
    new UuidV7Generator(),
    harness.telemetry,
  );
});

afterAll(async () => {
  await harness?.close();
});

async function parkRefund(wallet: WalletView, amount: string) {
  const betExternalId = crypto.randomUUID();
  const refund = await harness.submit.execute(
    wagerCommand(wallet, 'REFUND', amount, { referenceExternalTransactionId: betExternalId }),
  );
  if (refund.outcome !== 'RECORDED' || refund.status !== 'PENDING_REFERENCE') {
    throw new Error('expected a parked refund');
  }
  return { refundId: refund.transactionId, betExternalId };
}

/** `due` uses the application clock — the one the resolver claims with — not the DB's now(). */
async function transaction(id: string) {
  const [row] = await harness.sql`
    select status, failure_code, reference_attempts, reference_transaction_id,
           next_reference_check_at <= ${new Date()} as due
      from wager_transactions where id = ${id}`;
  return row;
}

async function events(walletId: string, type: string): Promise<number> {
  const [row] = await harness.sql`
    select count(*)::int as n from outbox_messages where aggregate_id = ${walletId} and event_type = ${type}`;
  return row.n;
}

/** Runs the resolver until it reports idle (other test files may leave due rows behind). */
async function resolveAllDue() {
  while ((await resolver.processDue(50)) > 0);
}

/** Makes one transaction unreadable (a "poison" row): loading it throws a non-transient error. */
class Poisoned implements UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly poisonTransactionId: string,
  ) {}

  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.inner.run((repositories) => {
      const { transactions } = repositories;
      const poisoned = Object.create(transactions) as WagerTransactionRepository;
      poisoned.findById = async (id) => {
        if (id === this.poisonTransactionId) throw new Error('unreadable row');
        return transactions.findById(id);
      };
      return work({ ...repositories, transactions: poisoned });
    });
  }
}

describe('pending references', () => {
  it('a REFUND that arrived before its BET is applied once the BET arrives (eager wake-up)', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const { refundId, betExternalId } = await parkRefund(wallet, '40.00');
    expect(await transaction(refundId)).toMatchObject({ due: false, reference_attempts: 1 });

    const bet = await harness.submit.execute(
      wagerCommand(wallet, 'BET', '40.00', { externalTransactionId: betExternalId }),
    );
    expect(await transaction(refundId)).toMatchObject({ due: true }); // woken up by the BET

    await resolveAllDue();

    expect(await transaction(refundId)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: bet.outcome === 'RECORDED' ? bet.transactionId : '',
    });
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('100.00');
    expect(await events(wallet.id, 'WagerTransactionPendingReference')).toBe(1);
    expect(await events(wallet.id, 'WagerTransactionProcessed')).toBe(2); // BET + REFUND
  });

  it('still missing: rescheduled with backoff, without a duplicate PendingReference event', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const { refundId } = await parkRefund(wallet, '10.00');
    await harness.sql`update wager_transactions set next_reference_check_at = ${new Date()} where id = ${refundId}`;

    await resolveAllDue();

    expect(await transaction(refundId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 2,
      due: false,
    });
    expect(await events(wallet.id, 'WagerTransactionPendingReference')).toBe(1);
  });

  it('retry budget exhausted: REJECTED with REFERENCE_NOT_FOUND and a Rejected event', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const { refundId } = await parkRefund(wallet, '10.00');
    await harness.sql`
      update wager_transactions
         set reference_attempts = ${REFERENCE_RETRY_POLICY.maxAttempts}, next_reference_check_at = ${new Date()}
       where id = ${refundId}`;

    await resolveAllDue();

    expect(await transaction(refundId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(await events(wallet.id, 'WagerTransactionRejected')).toBe(1);
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('100.00');
  });

  it('an unreadable row does not block the others: rescheduled, then FAILED with an event', async () => {
    const poisonWallet = await openTestWallet(harness, '100.00');
    const healthyWallet = await openTestWallet(harness, '100.00');
    const poison = await parkRefund(poisonWallet, '10.00');
    const healthy = await parkRefund(healthyWallet, '10.00');
    await harness.submit.execute(
      wagerCommand(healthyWallet, 'BET', '10.00', { externalTransactionId: healthy.betExternalId }),
    );
    // The poison row is first in line.
    await harness.sql`
      update wager_transactions set next_reference_check_at = ${new Date(Date.now() - 60_000)}
       where id = ${poison.refundId}`;
    const guarded = new ResolvePendingReferences(
      new Poisoned(new MikroOrmUnitOfWork(harness.orm), poison.refundId),
      new SystemClock(),
      new UuidV7Generator(),
      harness.telemetry,
    );

    while ((await guarded.processDue(50)) > 0);

    expect((await transaction(healthy.refundId)).status).toBe('PROCESSED');
    expect(await transaction(poison.refundId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: 2,
      due: false,
    });
    expect(harness.telemetry.pendingReferenceFailures).toContainEqual(
      expect.objectContaining({ transactionId: poison.refundId, outcome: 'RESCHEDULED', attempts: 2 }),
    );

    // On its last attempt it still gets one grace retry…
    await harness.sql`
      update wager_transactions
         set reference_attempts = ${REFERENCE_RETRY_POLICY.maxAttempts}, next_reference_check_at = ${new Date()}
       where id = ${poison.refundId}`;
    while ((await guarded.processDue(50)) > 0);
    expect(await transaction(poison.refundId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_attempts: REFERENCE_RETRY_POLICY.maxAttempts + 1,
    });

    // …and failing again past the budget is terminal: FAILED, with an event so nobody waits forever.
    await harness.sql`update wager_transactions set next_reference_check_at = ${new Date()} where id = ${poison.refundId}`;
    while ((await guarded.processDue(50)) > 0);

    expect(await transaction(poison.refundId)).toMatchObject({ status: 'FAILED', failure_code: 'INTERNAL_ERROR' });
    expect(harness.telemetry.pendingReferenceFailures).toContainEqual(
      expect.objectContaining({ transactionId: poison.refundId, outcome: 'FAILED' }),
    );
    const [failedEvent] = await harness.sql`
      select payload from outbox_messages
       where aggregate_id = ${poisonWallet.id} and event_type = 'WagerTransactionFailed'`;
    expect(failedEvent.payload.data).toMatchObject({
      transactionId: poison.refundId,
      walletId: poisonWallet.id,
      kind: 'REFUND',
      failureCode: 'INTERNAL_ERROR',
    });
    expect(await expectLedgerConsistent(harness.sql, poisonWallet.id)).toBe('100.00');
  });

  it('quarantine is compare-and-set: a row advanced by another resolver is left alone', async () => {
    const wallet = await openTestWallet(harness, '100.00');
    const { refundId } = await parkRefund(wallet, '10.00'); // attempts = 1
    const staleClaim = { transactionId: refundId, referenceAttempts: 1 };
    // Meanwhile another resolver rescheduled it.
    await harness.sql`update wager_transactions set reference_attempts = 2 where id = ${refundId}`;

    const unitOfWork = new MikroOrmUnitOfWork(harness.orm);
    const rescheduled = await unitOfWork.run((r) =>
      r.transactions.reschedulePendingReference(staleClaim, new Date(Date.now() + 60_000)),
    );
    const failed = await unitOfWork.run((r) =>
      r.transactions.failPendingReference(staleClaim, FailureCode.InternalError),
    );

    expect(rescheduled).toBe(false);
    expect(failed).toBeUndefined();
    expect(await transaction(refundId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 2 });
  });

  it('concurrent resolvers share the work: every parked transaction is applied exactly once', async () => {
    const wallet = await openTestWallet(harness, '1000.00');
    const parked = [];
    for (let i = 0; i < 10; i++) parked.push(await parkRefund(wallet, '5.00'));
    for (const { betExternalId } of parked) {
      await harness.submit.execute(wagerCommand(wallet, 'BET', '5.00', { externalTransactionId: betExternalId }));
    }

    const resolvers = [1, 2, 3].map(
      () =>
        new ResolvePendingReferences(
          new MikroOrmUnitOfWork(harness.orm),
          new SystemClock(),
          new UuidV7Generator(),
          harness.telemetry,
        ),
    );
    await Promise.all(resolvers.map(async (r) => {
      while ((await r.processDue(5)) > 0);
    }));

    for (const { refundId } of parked) {
      expect((await transaction(refundId)).status).toBe('PROCESSED');
    }
    const [credits] = await harness.sql`
      select count(*)::int as n from wallet_ledger_entries e
        join wager_transactions t on t.id = e.transaction_id
       where e.wallet_id = ${wallet.id} and t.kind = 'REFUND'`;
    expect(credits.n).toBe(10);
    expect(await expectLedgerConsistent(harness.sql, wallet.id)).toBe('1000.00');
  });
});
