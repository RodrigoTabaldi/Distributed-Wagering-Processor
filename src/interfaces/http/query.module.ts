import { Module } from '@nestjs/common';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../application/ports/repositories.js';
import {
  TELEMETRY,
  type Telemetry,
} from '../../application/ports/telemetry.js';
import {
  QueryWallets,
  ReconcileWallet,
  RECONCILIATION_READER,
  type ReconciliationReader,
} from '../../application/query-wallets.js';
import { PostgreSqlReconciliationReader } from '../../infrastructure/persistence/reconciliation-reader.js';
import { DatabaseModule } from '../../infrastructure/persistence/database.module.js';
import { DependencyHealth } from '../../infrastructure/health/dependency-health.js';
import { QueryController } from './query.controller.js';
import { HealthController } from './health.controller.js';
import { MetricsController } from './metrics.controller.js';
import { DocsController } from './docs.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [
    QueryController,
    HealthController,
    MetricsController,
    DocsController,
  ],
  providers: [
    DependencyHealth,
    {
      provide: RECONCILIATION_READER,
      useClass: PostgreSqlReconciliationReader,
    },
    {
      provide: QueryWallets,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new QueryWallets(uow),
    },
    {
      provide: ReconcileWallet,
      inject: [RECONCILIATION_READER, TELEMETRY],
      useFactory: (reader: ReconciliationReader, telemetry: Telemetry) =>
        new ReconcileWallet(reader, telemetry),
    },
  ],
})
export class QueryModule {}
