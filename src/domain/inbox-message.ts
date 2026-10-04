export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}
export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

export class InvalidInboxMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInboxMessageError';
  }
}
export class InboxPayloadConflictError extends Error {
  constructor() {
    super('Inbox identity was reused with a different payload');
    this.name = 'InboxPayloadConflictError';
  }
}

// A identidade é do transporte: cada consumidor pode receber a mesma mensagem uma única vez.
export class InboxMessage {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly #receivedAt: Date;
  #processedAt?: Date;

  private constructor(state: InboxMessageState) {
    this.messageId = state.messageId;
    this.consumerName = state.consumerName;
    this.payloadHash = state.payloadHash;
    // Date é mutável: cópias impedem que o chamador altere o histórico da mensagem.
    this.#receivedAt = new Date(state.receivedAt);
    this.#processedAt = state.processedAt
      ? new Date(state.processedAt)
      : undefined;
    Object.freeze(this);
  }
  static receive(props: ReceiveInboxProps): InboxMessage {
    this.validate(props);
    // receive sempre cria uma mensagem pendente, mesmo que a entrada contenha campos extras.
    return new InboxMessage({ ...props, processedAt: undefined });
  }
  static rehydrate(state: InboxMessageState): InboxMessage {
    // Reconstrói o registro sem executar novamente a operação associada à mensagem.
    this.validate(state);
    if (state.processedAt)
      this.validateProcessingDate(state.processedAt, state.receivedAt);
    return new InboxMessage(state);
  }
  private static validate(props: ReceiveInboxProps): void {
    for (const value of [props.messageId, props.consumerName]) {
      if (typeof value !== 'string' || !value.trim() || value !== value.trim())
        throw new InvalidInboxMessageError(
          'Inbox identifiers must be non-empty and trimmed',
        );
    }
    if (
      typeof props.payloadHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(props.payloadHash)
    )
      throw new InvalidInboxMessageError(
        'Inbox hash must be SHA-256 in lowercase hex',
      );
    if (
      !(props.receivedAt instanceof Date) ||
      !Number.isFinite(props.receivedAt.getTime())
    )
      throw new InvalidInboxMessageError('Invalid inbox receive date');
  }
  private static validateProcessingDate(at: Date, receivedAt: Date): void {
    if (
      !(at instanceof Date) ||
      !Number.isFinite(at.getTime()) ||
      at < receivedAt
    )
      throw new InvalidInboxMessageError(
        'Inbox processing date must not precede receive date',
      );
  }
  get receivedAt(): Date {
    return new Date(this.#receivedAt);
  }
  get processedAt(): Date | undefined {
    return this.#processedAt ? new Date(this.#processedAt) : undefined;
  }
  isProcessed(): boolean {
    return this.#processedAt !== undefined;
  }
  markProcessed(at: Date): void {
    // Reprocessar o objeto não pode substituir a data da primeira conclusão.
    if (this.isProcessed())
      throw new InvalidInboxMessageError('Inbox message is already processed');
    InboxMessage.validateProcessingDate(at, this.#receivedAt);
    this.#processedAt = new Date(at);
  }
}
