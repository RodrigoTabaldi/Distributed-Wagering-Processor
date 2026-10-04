export class InvalidWagerRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'InvalidWagerRequestError';
  }
}
import type { SubmitWagerInput } from '../../application/submit-wager.js';
import { WagerTransactionKind } from '../../domain/wager-transaction.js';

// Valida o contrato externo antes do hash: campos extras não podem mudar o significado da operação.
export class WagerRequest {
  static parse(
    body: unknown,
    header: unknown,
  ): { input: SubmitWagerInput; key: string } {
    const invalid = (code = 'INVALID_PAYLOAD'): never => {
      throw new InvalidWagerRequestError(code);
    };
    if (
      typeof header !== 'string' ||
      !header.trim() ||
      header.trim() !== header
    )
      return invalid('INVALID_IDEMPOTENCY_KEY');
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return invalid();
    const fields = body as Record<string, unknown>;
    const names = [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'kind',
      'money',
      'referenceExternalTransactionId',
    ];
    if (Object.keys(fields).some((name) => !names.includes(name)))
      return invalid();
    const text = (name: string): string => {
      const value = fields[name];
      if (typeof value !== 'string' || !value.trim() || value.trim() !== value)
        return invalid();
      return value;
    };
    const uuid = (name: string): string => {
      const value = text(name);
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          value,
        )
      )
        return invalid();
      return value.toLowerCase();
    };
    if (
      fields.kind !== WagerTransactionKind.Bet &&
      fields.kind !== WagerTransactionKind.Win &&
      fields.kind !== WagerTransactionKind.Loss &&
      fields.kind !== WagerTransactionKind.Refund &&
      fields.kind !== WagerTransactionKind.Rollback
    )
      return invalid();
    if (
      fields.referenceExternalTransactionId !== undefined &&
      fields.kind !== WagerTransactionKind.Win &&
      fields.kind !== WagerTransactionKind.Refund &&
      fields.kind !== WagerTransactionKind.Rollback
    )
      return invalid();
    // Reversões exigem a origem; WIN continua com referência opcional.
    if (
      (fields.kind === WagerTransactionKind.Refund ||
        fields.kind === WagerTransactionKind.Rollback) &&
      fields.referenceExternalTransactionId === undefined
    )
      return invalid();
    if (
      !fields.money ||
      typeof fields.money !== 'object' ||
      Array.isArray(fields.money)
    )
      return invalid();
    const money = fields.money as Record<string, unknown>;
    if (
      Object.keys(money).some((key) => !['amount', 'currency'].includes(key)) ||
      typeof money.amount !== 'string' ||
      typeof money.currency !== 'string'
    )
      return invalid();
    return {
      key: header,
      input: {
        providerId: text('providerId'),
        externalTransactionId: text('externalTransactionId'),
        playerId: uuid('playerId'),
        walletId: uuid('walletId'),
        roundId: text('roundId'),
        gameId: text('gameId'),
        kind: fields.kind,
        money: { amount: money.amount, currency: money.currency },
        ...(fields.referenceExternalTransactionId !== undefined
          ? {
              referenceExternalTransactionId: text(
                'referenceExternalTransactionId',
              ),
            }
          : {}),
      },
    };
  }
}
