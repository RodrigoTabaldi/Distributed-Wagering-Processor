import { Logger } from '@nestjs/common';
import type {
  WagerQueue,
  QueueDelivery,
} from '../../application/ports/messaging.js';
import { WagerConsumer } from '../../interfaces/sqs/wager-consumer.js';

// Um worker recebe uma mensagem por vez. Várias instâncias escalam por grupos FIFO/wallet.
export class SqsConsumerWorker {
  private readonly logger = new Logger(SqsConsumerWorker.name);
  private stopping = false;
  private loop?: Promise<void>;
  private readonly polling = new AbortController();
  private processing?: AbortController;
  constructor(
    private readonly consumer: WagerConsumer,
    private readonly queue: WagerQueue,
    private readonly graceMs = 10000,
  ) {}
  start(): void {
    if (!this.loop) this.loop = this.run();
  }
  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const deliveries = await this.queue.receive(this.polling.signal);
        for (const delivery of deliveries) {
          if (this.stopping) {
            await this.queue.changeVisibility(delivery, 0);
            continue;
          }
          await this.process(delivery);
        }
      } catch {
        if (!this.stopping) {
          this.logger.error(
            'SQS polling or delivery failed; original message remains recoverable',
          );
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              this.polling.signal.removeEventListener('abort', finish);
              resolve();
            };
            const timer = setTimeout(finish, 1000);
            this.polling.signal.addEventListener('abort', finish, {
              once: true,
            });
            if (this.polling.signal.aborted) finish();
          });
        }
      }
    }
  }
  private async process(delivery: QueueDelivery): Promise<void> {
    this.processing = new AbortController();
    // Mantém a mensagem invisível enquanto o processamento demora, sem depender de FIFO para dedup.
    let renewal = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewal = renewal
        .then(() => this.queue.changeVisibility(delivery, 30))
        .catch(() => {
          this.logger.warn(
            'SQS visibility renewal failed; Inbox still protects redelivery',
          );
        });
    }, 10000);
    let cancelled = false;
    try {
      const result = await this.consumer.handle(
        delivery,
        this.processing.signal,
      );
      cancelled = result === 'retry' && this.processing.signal.aborted;
    } finally {
      clearInterval(heartbeat);
      await renewal;
      // Uma renovação já em voo não pode esconder novamente a mensagem devolvida no shutdown.
      if (cancelled) await this.queue.changeVisibility(delivery, 0);
      this.processing = undefined;
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.polling.abort();
    // Dá tempo para concluir. Depois cancela SQL; handle devolve a visibilidade após o rollback.
    const deadline = setTimeout(() => this.processing?.abort(), this.graceMs);
    try {
      await this.loop;
    } finally {
      clearTimeout(deadline);
    }
  }
}
