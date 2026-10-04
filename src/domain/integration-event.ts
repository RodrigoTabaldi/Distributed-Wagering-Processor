export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

// Eventos aceitam apenas JSON simples. Money deve entrar como MoneyProps; Date só no envelope.
export function immutableJson<T>(value: T): T {
  const validate = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      item.forEach(validate);
      return;
    }
    if (
      item &&
      typeof item === 'object' &&
      Object.getPrototypeOf(item) === Object.prototype
    ) {
      Object.values(item).forEach(validate);
      return;
    }
    throw new Error('Event data must contain only plain JSON values');
  };
  validate(value);
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly #occurredAt: Date;
  readonly data: T;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const id of [
      props.eventId,
      props.aggregateId,
      props.correlationId,
      ...(props.causationId !== undefined ? [props.causationId] : []),
    ]) {
      if (typeof id !== 'string' || !id.trim() || id.trim() !== id)
        throw new Error('Invalid event identifier');
    }
    if (
      !(props.occurredAt instanceof Date) ||
      !Number.isFinite(props.occurredAt.getTime())
    )
      throw new Error('Invalid event date');
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.#occurredAt = new Date(props.occurredAt);
    this.data = immutableJson(props.data);
  }
  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }
  toJSON(): IntegrationEventEnvelope<T> {
    // O envelope versionado é o contrato público gravado na Outbox e enviado ao SQS.
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined
        ? { causationId: this.causationId }
        : {}),
      occurredAt: this.#occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
