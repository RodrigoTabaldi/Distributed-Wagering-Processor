import {
  InboxMessage,
  InboxPayloadConflictError,
  type ReceiveInboxProps,
} from '../domain/inbox-message.js';
import type { RepositorySession, UnitOfWork } from './ports/repositories.js';

// O ACK da fila pertence ao consumer (tarefa 20) e só poderá acontecer após este retorno.
export class ProcessInboxMessage {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  async execute(
    props: ReceiveInboxProps,
    operation: (session: RepositorySession) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<'processed' | 'duplicate'> {
    const received = InboxMessage.receive(props);
    return this.unitOfWork.transaction(async (session) => {
      // INSERT + lock persistente serializam entregas simultâneas da mesma identidade.
      const message = await session.inbox.receive(received);
      if (message.payloadHash !== received.payloadHash)
        throw new InboxPayloadConflictError();
      if (message.isProcessed()) return 'duplicate';
      // O chamador deve usar ESTA sessão: abrir outra transação quebraria a atomicidade.
      await operation(session);
      message.markProcessed(new Date());
      await session.inbox.markProcessed(message);
      return 'processed';
    }, signal);
  }
}
