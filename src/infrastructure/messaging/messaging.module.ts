import {
  Inject,
  Module,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../application/ports/repositories.js';
import { PublishOutbox } from '../../application/publish-outbox.js';
import {
  TELEMETRY,
  type Telemetry,
} from '../../application/ports/telemetry.js';
import { WagerConsumer } from '../../interfaces/sqs/wager-consumer.js';
import { DatabaseModule } from '../persistence/database.module.js';
import { SqsConsumerWorker } from '../workers/sqs-consumer.worker.js';
import { OutboxPublisherWorker } from '../workers/outbox-publisher.worker.js';
import { createSqsClient, resolveQueues, SqsTransport } from './sqs.js';

class MessagingRuntime
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private client?: ReturnType<typeof createSqsClient>;
  private consumer?: SqsConsumerWorker;
  private publisher?: OutboxPublisherWorker;
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(TELEMETRY) private readonly telemetry: Telemetry,
  ) {}
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.MESSAGING_ENABLED !== 'true') return;
    const providers = new Set(
      (process.env.SQS_ALLOWED_PROVIDERS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    if (!providers.size)
      throw new Error(
        'Configure SQS_ALLOWED_PROVIDERS before enabling messaging',
      );
    this.client = createSqsClient();
    try {
      const transport = new SqsTransport(
        this.client,
        await resolveQueues(this.client),
      );
      this.consumer = new SqsConsumerWorker(
        new WagerConsumer(this.uow, transport, providers, this.telemetry),
        transport,
      );
      this.publisher = new OutboxPublisherWorker(
        new PublishOutbox(this.uow, transport),
      );
      this.consumer.start();
      this.publisher.start();
    } catch (error) {
      this.client.destroy();
      throw error;
    }
  }
  async beforeApplicationShutdown(): Promise<void> {
    // Nest executa esta fase antes de OnApplicationShutdown, onde DatabaseModule fecha o PostgreSQL.
    await Promise.all([this.consumer?.stop(), this.publisher?.stop()]);
  }
  onApplicationShutdown(): void {
    this.client?.destroy();
  }
}
@Module({ imports: [DatabaseModule], providers: [MessagingRuntime] })
export class MessagingModule {}
