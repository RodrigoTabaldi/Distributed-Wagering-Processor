import { Logger } from '@nestjs/common';
import { PublishOutbox } from '../../application/publish-outbox.js';

export class OutboxPublisherWorker {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private readonly controller = new AbortController();
  constructor(
    private readonly publisher: PublishOutbox,
    private readonly graceMs = 10000,
  ) {}
  start(): void {
    if (!this.timer)
      this.timer = setInterval(() => {
        void this.tick();
      }, 1000);
    this.timer?.unref();
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.poll().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  private async poll(): Promise<void> {
    try {
      // Lote limitado deixa o shutdown observar o estado entre publicações.
      for (let i = 0; i < 25 && !this.stopping; i++) {
        const outcome = await this.publisher.runOne(
          new Date(),
          this.controller.signal,
        );
        if (outcome === 'idle') break;
        if (outcome === 'rescheduled')
          this.logger.warn(
            'Outbox send failed; event retained with retry agenda',
          );
      }
    } catch {
      this.logger.error(
        'Outbox publication transaction failed; event remains recoverable',
      );
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const deadline = setTimeout(() => this.controller.abort(), this.graceMs);
    try {
      await this.active;
    } finally {
      clearTimeout(deadline);
    }
  }
}
