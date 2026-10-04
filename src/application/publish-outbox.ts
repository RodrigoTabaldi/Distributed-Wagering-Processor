import type { UnitOfWork } from './ports/repositories.js';
import type { EventPublisher } from './ports/messaging.js';

export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
  ) {}
  async runOne(
    now = new Date(),
    signal?: AbortSignal,
  ): Promise<'idle' | 'published' | 'rescheduled'> {
    return this.unitOfWork.transaction(async ({ outbox }) => {
      const message = await outbox.lockNextDue(now);
      if (!message) return 'idle';
      const attempts = message.attempts;
      try {
        // Somente eventos já confirmados são visíveis a esta transação independente.
        await this.publisher.publish(message, signal);
      } catch {
        message.scheduleRetry(now);
        await outbox.save(message, attempts);
        return 'rescheduled';
      }
      // Falha depois do envio causa rollback: repetiremos o MESMO eventId. Entrega é ao menos uma vez.
      message.markPublished(new Date());
      await outbox.save(message, attempts);
      return 'published';
    }, signal);
  }
}
