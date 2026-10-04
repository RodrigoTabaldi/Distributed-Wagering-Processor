import { immutableJson, type IntegrationEvent } from './integration-event.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}
export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly #occurredAt: Date;
  #attempts: number;
  #nextAttemptAt?: Date;
  #publishedAt?: Date;
  private constructor(state: OutboxMessageState) {
    if (!Number.isInteger(state.attempts) || state.attempts < 0)
      throw new Error('Invalid outbox attempts');
    for (const date of [
      state.occurredAt,
      state.nextAttemptAt,
      state.publishedAt,
    ]) {
      if (
        date !== undefined &&
        (!(date instanceof Date) || !Number.isFinite(date.getTime()))
      )
        throw new Error('Invalid outbox date');
    }
    if (
      state.payload.eventId !== state.id ||
      state.payload.aggregateId !== state.aggregateId ||
      state.payload.eventType !== state.eventType
    )
      throw new Error('Outbox envelope identity mismatch');
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = immutableJson(state.payload);
    this.#occurredAt = new Date(state.occurredAt);
    this.#attempts = state.attempts;
    this.#nextAttemptAt = state.nextAttemptAt
      ? new Date(state.nextAttemptAt)
      : undefined;
    this.#publishedAt = state.publishedAt
      ? new Date(state.publishedAt)
      : undefined;
    Object.freeze(this);
  }
  static enqueue<T>(event: IntegrationEvent<T>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: { ...event.toJSON() },
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }
  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }
  get attempts(): number {
    return this.#attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this.#nextAttemptAt ? new Date(this.#nextAttemptAt) : undefined;
  }
  get publishedAt(): Date | undefined {
    return this.#publishedAt ? new Date(this.#publishedAt) : undefined;
  }
  isPending(): boolean {
    return this.#publishedAt === undefined;
  }
  isDue(now: Date): boolean {
    this.validDate(now);
    return (
      this.isPending() && (!this.#nextAttemptAt || this.#nextAttemptAt <= now)
    );
  }
  markPublished(at: Date): void {
    this.assertPending();
    this.validDate(at);
    // Só o publisher chama isto, depois da confirmação do SendMessage pelo SQS.
    this.#publishedAt = new Date(at);
    this.#nextAttemptAt = undefined;
  }
  scheduleRetry(now: Date): void {
    this.assertPending();
    this.validDate(now);
    this.#attempts++;
    // 1, 2, 4... segundos, até 60s. Nunca descartamos um evento financeiro confirmado.
    this.#nextAttemptAt = new Date(
      now.getTime() +
        Math.min(1000 * 2 ** Math.min(this.#attempts - 1, 16), 60000),
    );
  }
  private assertPending(): void {
    if (!this.isPending())
      throw new Error('Outbox message is already published');
  }
  private validDate(at: Date): void {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime()))
      throw new Error('Invalid outbox date');
  }
}
