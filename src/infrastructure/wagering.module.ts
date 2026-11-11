import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import {
  CLOCK,
  ID_GENERATOR,
  TELEMETRY,
  type Clock,
  type IdGenerator,
  type Telemetry,
} from '../application/ports/system';
import { WAGERING_QUERIES } from '../application/ports/queries';
import { UNIT_OF_WORK, type UnitOfWork } from '../application/ports/unit-of-work';
import { ResolvePendingReferences } from '../application/wagering/resolve-pending-references';
import { SubmitWagerTransaction } from '../application/wagering/submit-wager-transaction';
import { OpenWallet } from '../application/wallets/open-wallet';
import { ReconcileWallet } from '../application/wallets/reconcile-wallet';
import { MikroOrmWageringQueries } from './persistence/mikro-orm-queries';
import { MikroOrmUnitOfWork } from './persistence/mikro-orm-unit-of-work';
import { LoggingTelemetry, SystemClock, UuidV7Generator } from './system/system-adapters';

/** Wires the framework-free application use cases to their infrastructure adapters. */
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: TELEMETRY, useClass: LoggingTelemetry },
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm),
    },
    {
      provide: WAGERING_QUERIES,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroOrmWageringQueries(orm),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new SubmitWagerTransaction(uow, clock, ids),
    },
    {
      provide: ResolvePendingReferences,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, TELEMETRY],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, telemetry: Telemetry) =>
        new ResolvePendingReferences(uow, clock, ids, telemetry),
    },
    {
      provide: OpenWallet,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new OpenWallet(uow, clock, ids),
    },
    {
      provide: ReconcileWallet,
      inject: [UNIT_OF_WORK, TELEMETRY],
      useFactory: (uow: UnitOfWork, telemetry: Telemetry) => new ReconcileWallet(uow, telemetry),
    },
  ],
  exports: [
    SubmitWagerTransaction,
    ResolvePendingReferences,
    OpenWallet,
    ReconcileWallet,
    WAGERING_QUERIES,
    UNIT_OF_WORK,
    CLOCK,
    ID_GENERATOR,
  ],
})
export class WageringModule {}
