import type { UnitOfWork } from './ports/repositories.js';
import type { EventPublisher } from './ports/messaging.js';
import { randomUUID } from 'node:crypto';

// Cobre os dois attempts do SDK (até 25 s cada) com margem. Crash é recuperado após esse prazo.
export const OUTBOX_LEASE_MS = 90000;

export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
  ) {}
  async runOne(
    now = new Date(),
    signal?: AbortSignal,
  ): Promise<'idle' | 'published' | 'rescheduled' | 'superseded'> {
    const token = randomUUID();
    const message = await this.unitOfWork.transaction(
      ({ outbox }) => outbox.claimNextDue(now, token, OUTBOX_LEASE_MS),
      signal,
    );
    if (!message) return 'idle';
    let outcome: 'published' | 'rescheduled';
    try {
      // A reserva já foi confirmada: nenhum lock ou conexão SQL fica aberto durante a rede.
      await this.publisher.publish(message, signal);
      message.markPublished(new Date());
      outcome = 'published';
    } catch {
      message.scheduleRetry(new Date(Math.max(now.getTime(), Date.now())));
      outcome = 'rescheduled';
    }
    return this.unitOfWork.transaction(async (session) => {
      if (!(await session.outbox.saveClaimed(message, token)))
        return 'superseded';
      if (outcome === 'rescheduled') {
        session.recordAfterCommit?.({
          type: 'retry',
          source: 'outbox',
          correlationId: message.payload.correlationId as string,
        });
      }
      // Se este commit falhar, o lease expira e o mesmo eventId volta a ser enviado.
      return outcome;
    }, signal);
  }
}
