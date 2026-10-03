import { Module } from '@nestjs/common';
import { CreateWallet } from '../../application/create-wallet.js';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../application/ports/repositories.js';
import { DatabaseModule } from '../../infrastructure/persistence/database.module.js';
import { WalletController } from './wallet.controller.js';

// A factory injeta a porta UnitOfWork sem adicionar decorators NestJS ao caso de uso.
@Module({
  imports: [DatabaseModule],
  controllers: [WalletController],
  providers: [
    {
      provide: CreateWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new CreateWallet(unitOfWork),
    },
  ],
})
export class WalletModule {}
