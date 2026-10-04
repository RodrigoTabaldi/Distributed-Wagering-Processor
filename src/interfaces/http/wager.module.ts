import { Module } from '@nestjs/common';
import { SubmitWager } from '../../application/submit-wager.js';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../application/ports/repositories.js';
import { DatabaseModule } from '../../infrastructure/persistence/database.module.js';
import { WagerController } from './wager.controller.js';

// A aplicação permanece independente de decorators NestJS; o módulo injeta suas portas.
@Module({
  imports: [DatabaseModule],
  controllers: [WagerController],
  providers: [
    {
      provide: SubmitWager,
      inject: [UNIT_OF_WORK],
      useFactory: (uow: UnitOfWork) => new SubmitWager(uow),
    },
  ],
})
export class WagerModule {}
