// Requires `docker compose up -d postgres localstack`. End-to-end over real HTTP, the full Nest
// application and the real PostgreSQL `wagering_test` database.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startHttpHarness, type HttpHarness } from '../support/http-harness';
import { expectLedgerConsistent } from '../support/wagering-harness';

let http: HttpHarness;

beforeAll(async () => {
  http = await startHttpHarness();
});

afterAll(async () => {
  await http?.close();
});

interface Wallet {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

async function createWallet(amount = '1000.00'): Promise<Wallet> {
  const response = await http.post('/wallets', {
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  return response.body;
}

function wager(wallet: Wallet, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

function submit(body: Record<string, unknown>, key?: string) {
  const idempotencyKey = key ?? `${String(body.providerId)}:${String(body.externalTransactionId)}`;
  return http.post('/wagering/transactions', body, { 'Idempotency-Key': idempotencyKey });
}

describe('POST /wallets', () => {
  it('201 with the created wallet at version 1', async () => {
    const playerId = crypto.randomUUID();
    const response = await http.post('/wallets', {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    await expectLedgerConsistent(http.sql, response.body.id);
  });

  it('409 WALLET_ALREADY_EXISTS for the same player and currency', async () => {
    const body = { playerId: crypto.randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' } };
    await http.post('/wallets', body);

    const response = await http.post('/wallets', body);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it.each([
    ['invalid amount', { playerId: 'p', initialBalance: { amount: '10.001', currency: 'BRL' } }],
    ['numeric amount', { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } }],
    ['unknown field', { playerId: 'p', initialBalance: { amount: '1.00', currency: 'BRL' }, admin: true }],
    ['missing playerId', { initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['malformed JSON', '{"playerId": '],
  ])('400 VALIDATION_ERROR for %s', async (_, body) => {
    const response = await http.post('/wallets', body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /wallets/:walletId', () => {
  it('200 with the current state', async () => {
    const wallet = await createWallet('50.00');

    expect((await http.get(`/wallets/${wallet.id}`)).body).toEqual(wallet);
  });

  it.each([crypto.randomUUID(), 'not-a-uuid'])('404 NOT_FOUND for %p', async (walletId) => {
    const response = await http.get(`/wallets/${walletId}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /wagering/transactions', () => {
  it('200 PROCESSED, and an identical retry replays the same status and body', async () => {
    const wallet = await createWallet('1000.00');
    const bet = wager(wallet, 'BET', '25.00');

    const first = await submit(bet);
    const replay = await submit(bet);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await expectLedgerConsistent(http.sql, wallet.id)).toBe('975.00');
  });

  it('422 REJECTED with failureCode for business rule violations, replayed as 422', async () => {
    const wallet = await createWallet('10.00');
    const bet = wager(wallet, 'BET', '50.00');

    const first = await submit(bet);
    const replay = await submit(bet);

    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it('202 PENDING_REFERENCE when the reference has not arrived yet', async () => {
    const wallet = await createWallet('100.00');

    const response = await submit(
      wager(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: crypto.randomUUID() }),
    );

    expect(response.status).toBe(202);
    expect(response.body.status).toBe('PENDING_REFERENCE');
  });

  it('409 IDEMPOTENCY_CONFLICT for the same key with a different payload', async () => {
    const wallet = await createWallet('100.00');
    const bet = wager(wallet, 'BET', '10.00');
    const first = await submit(bet);

    const response = await submit({ ...bet, money: { amount: '11.00', currency: 'BRL' } });

    expect(response.status).toBe(409);
    expect(response.body.error).toEqual({
      code: 'IDEMPOTENCY_CONFLICT',
      message: expect.any(String),
      details: { transactionId: first.body.transactionId },
    });
  });

  it('404 WALLET_NOT_FOUND for an unknown wallet', async () => {
    const wallet = await createWallet('100.00');

    const response = await submit(wager(wallet, 'BET', '1.00', { walletId: crypto.randomUUID() }));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('400 when the Idempotency-Key header is missing', async () => {
    const wallet = await createWallet('100.00');

    const response = await http.post('/wagering/transactions', wager(wallet, 'BET', '1.00'));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['OPENING kind', { kind: 'OPENING' }],
    ['unknown kind', { kind: 'JACKPOT' }],
    ['scientific notation', { money: { amount: '1e2', currency: 'BRL' } }],
    ['negative amount', { money: { amount: '-1.00', currency: 'BRL' } }],
    ['three decimals', { money: { amount: '1.001', currency: 'BRL' } }],
    ['unknown field', { bonus: true }],
    ['REFUND without reference', { kind: 'REFUND' }],
  ])('400 VALIDATION_ERROR for %s', async (_, override) => {
    const wallet = await createWallet('100.00');

    const response = await submit({ ...wager(wallet, 'BET', '1.00'), ...override });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('echoes a provided X-Correlation-Id and mints one otherwise', async () => {
    const wallet = await createWallet('100.00');
    const bet = wager(wallet, 'BET', '1.00');

    const provided = await http.post('/wagering/transactions', bet, {
      'Idempotency-Key': `${bet.providerId}:${bet.externalTransactionId}`,
      'X-Correlation-Id': 'corr-123',
    });
    const minted = await http.get(`/wallets/${wallet.id}`);

    expect(provided.headers.get('x-correlation-id')).toBe('corr-123');
    expect(minted.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    const [event] = await http.sql`
      select payload->>'correlationId' as correlation_id
        from outbox_messages
       where aggregate_id = ${wallet.id} and event_type = 'WagerTransactionProcessed'`;
    expect(event.correlation_id).toBe('corr-123');
  });
});

describe('GET transactions', () => {
  it('by internal id and by provider + external id', async () => {
    const wallet = await createWallet('100.00');
    const bet = wager(wallet, 'BET', '30.00');
    const { body: submitted } = await submit(bet);

    const byId = await http.get(`/wagering/transactions/${submitted.transactionId}`);
    const byExternal = await http.get(
      `/providers/${bet.providerId}/wagering/transactions/${bet.externalTransactionId}`,
    );

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: submitted.transactionId,
      externalTransactionId: bet.externalTransactionId,
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
      status: 'PROCESSED',
      failureCode: null,
      balance: { amount: '70.00', currency: 'BRL' },
    });
    expect(byExternal.body).toEqual(byId.body);
  });

  it('404 for unknown transactions', async () => {
    expect((await http.get(`/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await http.get('/providers/provider-a/wagering/transactions/nope')).status).toBe(404);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  it('pages through every entry exactly once, in order, with an opaque cursor', async () => {
    const wallet = await createWallet('100.00');
    for (let i = 0; i < 12; i++) {
      await submit(wager(wallet, 'BET', '1.00'));
    }

    const pages: any[][] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=5&cursor=${cursor}` : '?limit=5';
      const response = await http.get(`/wallets/${wallet.id}/ledger${query}`);
      expect(response.status).toBe(200);
      pages.push(response.body.items);
      cursor = response.body.nextCursor;
    } while (cursor);

    expect(pages.map((page) => page.length)).toEqual([5, 5, 3]);
    const entries = pages.flat();
    expect(new Set(entries.map((e) => e.entryId)).size).toBe(13);
    expect(entries[0]).toMatchObject({ direction: 'CREDIT', balanceAfter: { amount: '100.00' } });
    expect(entries.at(-1)).toMatchObject({ direction: 'DEBIT', balanceAfter: { amount: '88.00' } });
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].balanceBefore).toEqual(entries[i - 1].balanceAfter);
    }
    expect(entries[0].sequence).toBeUndefined();
  });

  it('defaults to 50 items and returns a null cursor on the last page', async () => {
    const wallet = await createWallet('100.00');

    const response = await http.get(`/wallets/${wallet.id}/ledger`);

    expect(response.body).toEqual({ items: [expect.any(Object)], nextCursor: null });
  });

  it('400 for invalid cursors (including another wallet’s) and limits', async () => {
    const wallet = await createWallet('100.00');
    const other = await createWallet('100.00');
    await submit(wager(other, 'BET', '1.00'));
    const { body } = await http.get(`/wallets/${other.id}/ledger?limit=1`);

    for (const query of ['?cursor=garbage', `?cursor=${body.nextCursor}`, '?limit=0', '?limit=201', '?limit=abc', '?page=2']) {
      const response = await http.get(`/wallets/${wallet.id}/ledger${query}`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('404 for unknown wallets', async () => {
    expect((await http.get(`/wallets/${crypto.randomUUID()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('200 with a consistent report', async () => {
    const wallet = await createWallet('975.00');

    const response = await http.post(`/wallets/${wallet.id}/reconciliation`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
  });

  it('404 for unknown wallets', async () => {
    expect((await http.post(`/wallets/${crypto.randomUUID()}/reconciliation`)).status).toBe(404);
  });
});

describe('routing and health', () => {
  it('unknown routes are 404 in the standard error format', async () => {
    const response = await http.get('/nope');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('health endpoints stay public', async () => {
    expect((await http.get('/health/live')).status).toBe(200);
  });
});
