import { createHash } from 'node:crypto';
import { WagerRequest } from '../validation/wager-request.js';

export class InvalidWagerEnvelopeError extends Error {
  constructor() {
    super('Invalid WagerTransactionRequested envelope');
    this.name = 'InvalidWagerEnvelopeError';
  }
}
export function parseWagerEnvelope(
  body: string,
  allowedProviders: ReadonlySet<string>,
) {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidWagerEnvelopeError();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidWagerEnvelopeError();
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).some(
      (key) => !['messageId', 'type', 'occurredAt', 'data'].includes(key),
    ) ||
    typeof envelope.messageId !== 'string' ||
    !envelope.messageId.trim() ||
    envelope.messageId.trim() !== envelope.messageId ||
    envelope.type !== 'WagerTransactionRequested' ||
    typeof envelope.occurredAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      envelope.occurredAt,
    ) ||
    !Number.isFinite(Date.parse(envelope.occurredAt)) ||
    new Date(envelope.occurredAt).toISOString() !== envelope.occurredAt ||
    !envelope.data ||
    typeof envelope.data !== 'object' ||
    Array.isArray(envelope.data)
  )
    throw new InvalidWagerEnvelopeError();
  const { idempotencyKey, ...business } = envelope.data as Record<
    string,
    unknown
  >;
  const { input, key } = WagerRequest.parse(business, idempotencyKey);
  // Lista explícita de provedores confiáveis para este consumer. Autenticação futura pertence ao adapter.
  if (!allowedProviders.has(input.providerId))
    throw new InvalidWagerEnvelopeError();
  // Hash da Inbox cobre o corpo integral: identidade de transporte não pode trocar seu conteúdo.
  const canonical = (item: unknown): string => {
    if (item && typeof item === 'object' && !Array.isArray(item))
      return `{${Object.keys(item)
        .sort()
        .map(
          (k) =>
            `${JSON.stringify(k)}:${canonical((item as Record<string, unknown>)[k])}`,
        )
        .join(',')}}`;
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    return JSON.stringify(item);
  };
  return {
    messageId: envelope.messageId,
    input,
    key,
    payloadHash: createHash('sha256').update(canonical(envelope)).digest('hex'),
  };
}
