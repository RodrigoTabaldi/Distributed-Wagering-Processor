import { Module } from '@nestjs/common';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../application/ports/repositories.js';
import { ReprocessPendingReferences } from '../../application/reprocess-pending-references.js';
import { DatabaseModule } from '../persistence/database.module.js';
import { PendingReferenceWorker } from './pending-reference.worker.js';

// O worker usa os mesmos casos de uso e a mesma transação financeira da API.
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: ReprocessPendingReferences,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new ReprocessPendingReferences(uow),
    },
    PendingReferenceWorker,
  ],
})
export class PendingReferenceModule {}
