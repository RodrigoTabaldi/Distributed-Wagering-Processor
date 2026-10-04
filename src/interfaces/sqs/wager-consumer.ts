import { Logger } from '@nestjs/common';
import { ProcessInboxMessage } from '../../application/process-inbox-message.js';
import { SubmitWager } from '../../application/submit-wager.js';
import type { UnitOfWork } from '../../application/ports/repositories.js';
import type {
  QueueDelivery,
  WagerQueue,
} from '../../application/ports/messaging.js';
import { InvalidMoneyError } from '../../domain/money.js';
import { InboxPayloadConflictError } from '../../domain/inbox-message.js';
import {
  IdempotencyConflictError,
  InvalidWagerTransactionError,
} from '../../domain/wager-transaction.js';
import { InvalidBetError } from '../../application/process-bet.js';
import { InvalidWagerRequestError } from '../validation/wager-request.js';
import {
  parseWagerEnvelope,
  InvalidWagerEnvelopeError,
} from './wager-envelope.js';

export const CONSUMER_NAME = 'wager-transactions';
export const MAX_RECEIVE_ATTEMPTS = 5;
export function queueRetrySeconds(receiveCount: number): number {
  return Math.min(2 ** Math.min(Math.max(receiveCount - 1, 0), 6), 60);
}

export class WagerConsumer {
  private readonly logger = new Logger(WagerConsumer.name);
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly queue: WagerQueue,
    private readonly providers: ReadonlySet<string>,
  ) {}
  async handle(
    delivery: QueueDelivery,
    signal?: AbortSignal,
  ): Promise<'acknowledged' | 'retry' | 'dead-lettered'> {
    let failure: unknown;
    try {
      const parsed = parseWagerEnvelope(delivery.body, this.providers);
      await new ProcessInboxMessage(this.unitOfWork).execute(
        {
          messageId: parsed.messageId,
          consumerName: CONSUMER_NAME,
          payloadHash: parsed.payloadHash,
          receivedAt: new Date(),
        },
        async (session) => {
          // Mesmo SubmitWager do HTTP, com a sessão da Inbox: nenhum commit financeiro independente.
          await new SubmitWager(this.unitOfWork).executeInTransaction(
            session,
            parsed.input,
            parsed.key,
            { correlationId: parsed.messageId, causationId: parsed.messageId },
          );
        },
        signal,
      );
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined && signal?.aborted) {
      // Após cancelar e desfazer a transação, devolve a mensagem para outra instância.
      await this.queue.changeVisibility(delivery, 0);
      return 'retry';
    }
    if (failure === undefined) {
      // Só depois do commit. Falha no ACK deixa a mensagem reaparecer; Inbox preserva o saldo.
      await this.queue.acknowledge(delivery);
      return 'acknowledged';
    }
    const permanent =
      failure instanceof InvalidWagerEnvelopeError ||
      failure instanceof InvalidWagerRequestError ||
      failure instanceof InvalidMoneyError ||
      failure instanceof InvalidWagerTransactionError ||
      failure instanceof InvalidBetError ||
      failure instanceof IdempotencyConflictError ||
      failure instanceof InboxPayloadConflictError;
    if (permanent || delivery.receiveCount >= MAX_RECEIVE_ATTEMPTS) {
      // Envia à DLQ antes de apagar a origem. Se o envio falhar, a origem permanece recuperável.
      await this.queue.deadLetter(
        delivery,
        permanent ? 'PERMANENT_INPUT_ERROR' : 'RETRY_LIMIT_EXCEEDED',
      );
      await this.queue.acknowledge(delivery);
      this.logger.warn('Wager delivery moved to DLQ');
      return 'dead-lettered';
    }
    await this.queue.changeVisibility(
      delivery,
      queueRetrySeconds(delivery.receiveCount),
    );
    this.logger.warn(
      'Wager transaction rolled back; delivery scheduled for retry',
    );
    return 'retry';
  }
}
