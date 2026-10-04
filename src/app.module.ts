import {
  Module,
  type NestModule,
  type MiddlewareConsumer,
} from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './infrastructure/persistence/database.module.js';
import { WalletModule } from './interfaces/http/wallet.module.js';
import { WagerModule } from './interfaces/http/wager.module.js';
import { PendingReferenceModule } from './infrastructure/workers/pending-reference.module.js';
import { MessagingModule } from './infrastructure/messaging/messaging.module.js';
import { QueryModule } from './interfaces/http/query.module.js';
import {
  ObservabilityModule,
  CorrelationMiddleware,
} from './infrastructure/observability/observability.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObservabilityModule,
    DatabaseModule,
    WalletModule,
    WagerModule,
    PendingReferenceModule,
    MessagingModule,
    QueryModule,
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'dwp',
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
