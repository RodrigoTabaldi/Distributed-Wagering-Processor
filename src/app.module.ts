import {
  Module,
  type NestModule,
  type MiddlewareConsumer,
} from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './infrastructure/persistence/database.module.js';
import { WalletModule } from './interfaces/http/wallet.module.js';
import { WagerModule } from './interfaces/http/wager.module.js';
import { PendingReferenceModule } from './infrastructure/workers/pending-reference.module.js';
import { MessagingModule } from './infrastructure/messaging/messaging.module.js';
import { QueryModule } from './interfaces/http/query.module.js';
import { AuthModule } from './interfaces/http/auth.module.js';
import {
  ObservabilityModule,
  CorrelationMiddleware,
} from './infrastructure/observability/observability.js';

@Module({
  imports: [
    ObservabilityModule,
    AuthModule,
    DatabaseModule,
    WalletModule,
    WagerModule,
    PendingReferenceModule,
    MessagingModule,
    QueryModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
