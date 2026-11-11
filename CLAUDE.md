# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Done so far: scaffold (NestJS, health endpoints, MikroORM migrations, SQS client, Docker Compose), the **domain layer**, the **schema**, **persistence** and the **use cases** (`SubmitWagerTransaction`, `OpenWallet`, `ReconcileWallet`) with concurrency tests, the **HTTP API** (§9), and **messaging** (SQS consumer, outbox relay, pending-reference resolver; §7.1, §10, §11). Not built yet: multi-process test, metrics, final `README.md`, `ARCHITECTURE.md`. The **challenge specification** (Jungle Gaming — Distributed Wagering Processor, written in Portuguese) lives in `docs/CHALLENGE.md`. It is the source of truth for requirements; section numbers below (§) refer to it. `README.md` is currently still a copy of the spec and is meant to be rewritten.

Required deliverables per the spec: a `README.md` with setup and commands, and an `ARCHITECTURE.md` justifying decisions, trade-offs and limitations (ORM choice, `Money` mapping, transactional/locking strategy, failure-code taxonomy, retry limits/TTL, idempotency hash algorithm, HTTP status mapping, auth decision).

## Stack (mandatory, §4)

- **Bun 1.x** as runtime, package manager **and test runner** (`bun test`)
- **TypeScript** strict mode, **NestJS**
- **PostgreSQL**; migrations must be versioned and reversible
- **AWS SQS** via LocalStack or MiniStack; queues `wager-transactions.fifo` and `wager-transactions-dlq.fifo`
- **Docker Compose** for local orchestration
- ORM: **MikroORM (preferred)** or TypeORM. Prisma and other ORMs are not allowed.
- Auth is unscored (§2): either integrate an external IdP (Keycloak/Zitadel), or document the decision and leave an explicit extension point (e.g. no-op `AuthGuard`). Health endpoints stay open.

## Commands

```bash
cp .env.example .env                        # Bun auto-loads .env
docker compose up -d --wait postgres localstack
bun install
bun run migration:up                        # also: migration:down, migration:create <name>
bun run dev                                 # watch mode; `bun run start` without watch

bun run typecheck && bun run lint
bun run test:unit                           # no infra needed
bun run test:integration                    # needs postgres + localstack running
bun test test/unit/app-config.test.ts       # single file
bun test -t "rejects invalid PORT"          # single test by name

# Multi-instance run (app + migrate are under the `app` profile)
docker build -t wagering-app:dev .
docker compose --profile app up -d --no-build --scale app=3   # host ports 3000-3005
```

Spec-mandated name, not yet implemented: `bun run test:load` (optional load test; report environment, methodology, throughput, p50/p95/p99, error rate, concurrency conflicts, outbox lag).

Setup gotchas:

- `bunfig.toml` sets `linker = "isolated"`. Don't remove it: the hoisted layout makes `@mikro-orm/migrations` (via umzug → `ajv-draft-04`) resolve eslint's `ajv@6` and crash. The Dockerfile copies `bunfig.toml` before `bun install` for the same reason.
- `docker compose build` fails in this directory because the path contains a non-ASCII `—` (BuildKit gRPC header error). Build with plain `docker build -t wagering-app:dev .`, then use `--no-build`.
- Postgres is exposed on host port **5440** (`POSTGRES_HOST_PORT`), since 5432 is taken by other local databases.
- Migrations are run by `src/infrastructure/persistence/migrate.ts` (the programmatic MikroORM `Migrator`), not the MikroORM CLI. They are `.ts` files in `migrations/`, and each runs in a transaction (`allOrNothing`).

## Code layout

Hexagonal layering under `src/`: `domain/` (pure TS, no Nest/ORM imports), `application/` (use cases + ports), `infrastructure/` (config, MikroORM, SQS adapters), `interfaces/http/` (controllers). Config comes from `loadConfig(process.env)` in `src/infrastructure/config/app-config.ts`, injected via the `APP_CONFIG` token. The SQS client is injected via `SQS_CLIENT`. Inject `MikroORM` from `@mikro-orm/core`.

Domain notes:
- `src/domain/wagering/wager-settlement.ts` (`settleWagerTransaction`) is where BET/WIN/LOSS/REFUND/ROLLBACK rules live. It mutates the `Wallet` and the `WagerTransaction` and returns PROCESSED (+ optional ledger entry), REJECTED (+ `FailureCode`) or PENDING_REFERENCE. The caller resolves the reference and the "already reversed" flag, holds the wallet concurrency guard, and persists the result.
- The domain never generates ids or reads the clock: ids and `at: Date` are passed in. It also doesn't hash: `payloadHash` comes from the application.
- `Wallet.open` returns `{ wallet, openingEntry }`. The application must persist the OPENING transaction (`WagerTransaction.createOpening`) and the entry in the same SQL transaction.
- All events use `walletId` as `aggregateId`. The outbox row id equals the event id.
- Retry policies: `REFERENCE_RETRY_POLICY` (10 attempts, 1s doubling, capped at 5 min) and `OUTBOX_RETRY_POLICY` (no attempt limit).

Application and persistence:
- Use cases in `src/application/` are plain classes (no Nest decorators). They're wired in `src/infrastructure/wagering.module.ts` through factory providers.
- They depend on ports: `UnitOfWork` and the repositories (`application/ports/unit-of-work.ts`), plus `Clock`, `IdGenerator` (UUIDv7) and `Telemetry`.
- `MikroOrmUnitOfWork.run` opens one SQL transaction (READ COMMITTED) with `SET LOCAL lock_timeout`/`statement_timeout`. It translates DB errors into `TransientInfrastructureError` (lock timeout, deadlock, connection) or `UniquenessViolationError` (mapped from constraint names).
- Persistence records are `EntitySchema`s in `infrastructure/persistence/records.ts`, separate from domain classes.
- Repositories are data mappers: reads use `disableIdentityMap`, writes are explicit `em.insert`/`nativeUpdate`. The caller orders writes to satisfy FKs: transaction → wallet update → ledger → outbox.
- Concurrency strategy: `SubmitWagerTransaction` locks the wallet row (`LockMode.PESSIMISTIC_WRITE`) before deciding, and checks duplicates before and again under the lock. A same-key race across *different* wallets is caught by the UNIQUE constraints and resolved as replay/conflict in a fresh unit of work.
- Duplicate lookup (`findDuplicates`) must stay a **single SQL statement**. Two separate queries (key, then external id) can straddle a concurrent commit and turn a replay into a false conflict; this was a real flaky bug.
- `wager_transactions.observed_balance` (wallet currency) is what replays return as the original balance.
- Outbox payloads are deep-copied in the mapper because MikroORM mutates query params in place and event data is frozen.

HTTP layer (`src/interfaces/http/`):
- `HttpApiModule` holds the controllers, the global `ApiExceptionFilter` and the global `AuthGuard`.
- `toErrorResponse` in `errors/api-exception.filter.ts` is the **single** failure→HTTP mapping. Throw `ApiError` or let domain/application errors propagate; don't build error responses in controllers.
- Error body is always `{ error: { code, message, details? } }`.
- Submit statuses (replays return the original code): PROCESSED 200, PENDING_REFERENCE 202, REJECTED 422 (+`failureCode`).
- Error statuses: invalid payload or missing `Idempotency-Key` 400, idempotency conflict 409, unknown wallet 404 `WALLET_NOT_FOUND`, `TransientInfrastructureError` 503 + `Retry-After`. A `DomainError` is 400, except `InvalidTransactionStateError`, which is a bug and returns 500.
- Request contracts in `schemas.ts` (zod, `.strict()`: unknown fields are 400). zod checks shape only; money format is validated by the domain `Money`.
- `X-Correlation-Id` is resolved in pino-http `genReqId` (`correlation-id.ts`). It's echoed on responses, logged, and passed into commands and events via `@CorrelationId()`.
- Ledger pagination: `ledger-cursor.ts` (base64url `{v, w: walletId, s: sequence}`). A cursor from another wallet is rejected.
- Auth: `auth/auth.ts` is the extension point (`REQUEST_AUTHENTICATOR`, default allow-all; `@Public()` for health). No IdP by design.
- Read endpoints go through the `WageringQueries` port (`MikroOrmWageringQueries`), not the use cases.

Messaging and workers:
- `WorkersModule` (`infrastructure/workers/`) runs three workers in **every** app instance, toggled by `WORKERS_ENABLED`: the SQS consumer, the outbox relay (`PublishOutbox`) and the pending-reference resolver (`ResolvePendingReferences`).
- They stop in `beforeApplicationShutdown`, so they finish before the ORM and SQS client close.
- Test harnesses set `WORKERS_ENABLED=false`.
- **SQS consumer** (`SqsQueueConsumer`) is generic over a `MessageHandler`. `WagerTransactionMessageHandler` (`interfaces/messaging/`) parses the §10 envelope (`interfaces/contracts.ts`, shared with HTTP) and calls the same `SubmitWagerTransaction`, passing an `inbox` receipt.
- The inbox row is the first write of the same unit of work. A duplicate delivery hits `inbox_messages_pk`, and the result is `DUPLICATE_MESSAGE` (or `MESSAGE_PAYLOAD_CONFLICT`).
- Message actions:
  - ack: every business outcome, and duplicates;
  - dlq: malformed or invalid payloads, and payload conflicts. Sent to the DLQ explicitly, then deleted;
  - retry: transient or unexpected errors. Visibility is backed off by `ApproximateReceiveCount` (2s doubling, capped at 300s). The queue redrive (maxReceiveCount **30**, about 2h) moves the message to the DLQ. Every receive counts, including releases (shutdown, batch deadline, an earlier message of the group retrying), so the tail of a stuck group spends budget too. Don't lower it, or a short DB outage dead-letters valid wagers.
- The consumer deletes the message only after the handler returns, i.e. after commit. Groups run in parallel and messages within a group sequentially. Stopping resets visibility to 0 for deliveries not yet started.
- A message of a group is only *started* within the first half of the visibility window; the rest of the group is released. This keeps a slow group from being redelivered mid-processing.
- **Don't add a `ChangeMessageVisibility` heartbeat**: LocalStack 4.4 rejects the original receipt handle on `DeleteMessage` once the initial window passes, even after extending it (verified).
- **Outbox relay**: `claimDue` uses `FOR UPDATE SKIP LOCKED`. It publishes inside the claiming transaction, then marks the rows published or `scheduleRetry`. A crash before COMMIT means the event is re-sent with the same eventId.
- Events go to `wager-events.fifo` (`SqsEventPublisher`: group = walletId, dedup id = eventId).
- **Pending references**: the resolver claims one row at a time with `FOR NO KEY UPDATE SKIP LOCKED` (NO KEY so FK `KEY SHARE` from concurrent inserts never blocks), then locks the wallet. Lock order is tx row → wallet; the submit path only locks wallets, so the two cannot deadlock.
- A row failing for a non-transient reason is quarantined in a separate unit of work: rescheduled with backoff on the same retry budget, then `FAILED`/`INTERNAL_ERROR`, reported via `Telemetry.pendingReferenceResolutionFailed`. This way it can't block the queue.
- When a transaction is PROCESSED, `wakeDependents` makes parked transactions referencing it due now (`SKIP LOCKED` update).
- All time comparisons use the application `Clock` passed as a parameter, never the DB's `now()`. Tests must do the same: the Docker VM clock drifts from the host, which made one test flaky.

Schema (`migrations/Migration20261111164422_core_schema.ts`) enforces the invariants itself; read its header before changing persistence:
- Every money column is `numeric(19,2)`.
- The ledger is append-only (UPDATE/DELETE/TRUNCATE blocked by triggers). An insert trigger locks the wallet row, assigns `sequence` (the per-wallet pagination cursor) and checks the chain `balance_before` = previous `balance_after`.
- A **deferred constraint trigger** fails the commit if `wallets.balance` ≠ last ledger `balance_after`. So a balance change and its ledger entry must be written in the same SQL transaction, and these errors surface at COMMIT.
- The `wallets` trigger requires `version` +1 exactly when the balance changes.
- Terminal `wager_transactions` rows are frozen. A PROCESSED reversal per referenced transaction is unique (partial index).
- A ledger entry's FK `(transaction_id, wallet_id, currency, amount)` must match its transaction.
- `wager_transactions.wallet_id` is a FK, so WALLET_NOT_FOUND requests cannot be persisted (they are answered, not stored).

Interpretations adopted (to be documented in `ARCHITECTURE.md`):
- Amounts are accepted with 0–2 decimals ("25", "25.5") and always serialized with 2.
- A transaction can be reversed **at most once in total** (REFUND *or* ROLLBACK), not once per kind, to prevent a double credit. A ROLLBACK of a REFUND is allowed, because the reference is a different transaction.
- WIN/LOSS may optionally reference a BET; when they do, the same reference rules apply.
- Amounts are > 0, except LOSS, which may be 0.

Tests: `test/support/domain-fixtures.ts` holds the domain builders. `test/support/wagering-harness.ts` builds the real use cases on the test DB and has `expectLedgerConsistent` (the mandatory final invariant), `wagerCommand` and `holdWalletLock` (holds a row lock from another connection, to prove per-wallet locking and lock timeouts). `test/support/messaging-harness.ts` creates per-file LocalStack FIFO queues (main with redrive, DLQ, events), plus `wagerMessage`, `send`, `drain` and `waitFor`. Outbox/recovery tests first mark leftover pending outbox rows as published, because the test DB is shared across files. `test/support/http-harness.ts` boots the real `AppModule` on the test DB for E2E HTTP tests (`http-api.test.ts`). Concurrency tests are statistical: when touching them, run `bun test test/integration/concurrency.test.ts` several times in a row. Integration tests that touch the schema use the separate `wagering_test` database (created on demand by `test/support/test-database.ts`; override with `TEST_DATABASE_URL`). That's because `schema.test.ts` migrates down and up. Tables are append-only, so tests isolate with random UUIDs instead of cleanup.

## Non-negotiable constraints (§5, §14 eliminatory failures)

Violating any of these fails the challenge:

- Never use `number`/float for money — decimal strings + a decimal library in the domain, exact column types in the DB.
- Idempotency must be persistent (DB), never an in-memory cache. Don't rely on SQS FIFO dedup/ordering for correctness.
- Never publish events before the financial transaction commits (use the transactional outbox).
- Ledger is append-only: no updates or deletes.
- No global lock shared across wallets; no unguarded `read → calculate → update` of balance.
- Must be correct with **≥3 concurrent instances**.
- Uniqueness, immutability and non-negativity must be enforced **in the DB schema** (constraints, unique indexes, CHECKs, triggers), not only in application code.
- Tests must hit real PostgreSQL and SQS (containers); fully mocking them is eliminatory.

## Architecture (big picture)

**Domain layer** is framework-free (no ORM types, no NestJS decorators). Entities use `private`/`protected` constructors with static factories (`create`/`from`/`open`/`receive`/`enqueue`); `rehydrate` rebuilds persisted state **without** re-validating transitions.

- `Money` (§6.1): immutable; amount is a decimal string with fixed scale 2; rejects NaN, Infinity, scientific notation, empty, >2 decimals, negatives on input contracts; cross-currency ops throw a domain error. Single currency (BRL) is acceptable but the model stays multi-currency and currency conflicts must be tested.
- `Wallet` (§6.2, aggregate root): one per `playerId + currency`; balance never negative; every balance change has exactly one ledger entry and vice versa; `version` starts at 1 and increments **only when balance changes**. **The unit of concurrency is `walletId`.**
- `WagerTransaction` (§6.3): born `PENDING`; may go to `PENDING_REFERENCE`; terminal states `PROCESSED`, `REJECTED`, `FAILED` — transitioning from a terminal state is a programming error (`InvalidTransactionStateError`). `OPENING` kind is internal only (created by `POST /wallets` when initial balance > 0, same SQL tx) and must be rejected from API/queue.
- `WalletLedgerEntry` (§6.4): structurally immutable; factory verifies `balanceBefore ± money === balanceAfter`; at most one entry per transaction per wallet; `LOSS` and rejected transactions produce no entry.
- `InboxMessage` / `OutboxMessage` (§6.5), `IntegrationEvent<T>` abstract envelope with one subclass per event; `eventType`/`version` live on the type; `data` carries `MoneyProps`, never `Money` instances.

**Processing flow**:

- HTTP (`POST /wagering/transactions`) and the SQS consumer call **the same use case**.
- One SQL transaction covers: inbox record (SQS path, dedup by `(consumerName, messageId)`) + wager transaction + balance update + ledger entry + outbox event. SQS ack only after commit.
- Consumer classifies errors: business → terminal + ack; transient → retry with backoff; permanent → DLQ after attempt limit. On `SIGTERM`, finish in-flight messages or return visibility.
- **Outbox worker** must be safe with multiple concurrent publishers (e.g. `FOR UPDATE SKIP LOCKED` claim), retry with backoff; duplicates must be harmless downstream.
- **PENDING_REFERENCE worker** (§7.1): scheduled retry with exponential backoff; after limit/TTL → `REJECTED` with a "reference not found" failure code + event.
- Events (§11): `WagerTransactionProcessed` (incl. `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` (only when balance changes), `WagerTransactionPendingReference`.

**Idempotency** (§9): `Idempotency-Key` header is mandatory and the source of truth (default `{providerId}:{externalTransactionId}`). `payloadHash` = hash of canonical JSON (sorted keys) of business fields only. Same key + same payload → original response (including the balance observed then) with `idempotentReplay: true`; same key + different payload → conflict, not replay. HTTP status codes must consistently distinguish: invalid payload, idempotency conflict, business rejection, accepted-pending, transient infra failure.

## Business rules (§7)

| Kind | Balance | Ledger | Rule |
|---|---|---|---|
| BET | debit | 1 DEBIT | reject on insufficient funds |
| WIN | credit | 1 CREDIT | may reference the round's BET |
| LOSS | none | none | records result only |
| REFUND | credit | 1 CREDIT | reverts a PROCESSED BET, once |
| ROLLBACK | inverse of reference | 1 inverted | reverts a PROCESSED BET/WIN/REFUND, once |

- REFUND/ROLLBACK require `referenceExternalTransactionId`, resolved by `(providerId, referenceExternalTransactionId)`; reference must match provider, player, wallet, currency and round; amount must equal the reference (no partial reversal); a reference can't be reverted twice by the same kind.
- A reversal that would make the balance negative is rejected with a `failureCode` **distinct** from BET insufficient funds.
- Every rejection carries a stable, machine-readable `failureCode` (taxonomy documented in `ARCHITECTURE.md`).
- Reconciliation (`POST /wallets/:walletId/reconciliation`) never silently fixes divergences: log, count in a metric, flag in the response.

## Testing requirements (§13)

Invariant asserted at the end of **every** test: `wallet.balance == balance rebuilt from the ledger`.

Mandatory concurrency scenario (§8): balance `100.00 BRL`, two simultaneous `80.00` BETs → exactly one `PROCESSED`, one `REJECTED` (insufficient funds), final balance `20.00`, exactly one DEBIT entry. Other required race tests: same BET 50× in parallel → one debit; distinct wallets in parallel; ≥3 processes; worker killed after commit/before ack; two outbox publishers; REFUND/ROLLBACK before reference; service restart with final consistency. Concurrency tests must use real parallelism, not sequential mocks.

## Observability (§12)

Structured JSON logs with `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` — no sensitive data or full financial payloads. Metrics: transactions by status, duplicates, retries, DLQ messages, lock conflicts, outbox lag, processing latency. `GET /health/live` and `GET /health/ready` (checks PostgreSQL and SQS).
