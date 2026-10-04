import { describe, expect, it } from 'bun:test';
import { FailureCode, IdempotencyConflictError } from './wager-transaction.js';

describe('Public failure code contract', () => {
  // Estes valores são lidos por provedores. Renomear uma string quebraria o contrato externo.
  it('preserves the documented machine-readable values', () => {
    const expected = [
      'BALANCE_LIMIT_EXCEEDED',
      'INSUFFICIENT_BALANCE',
      'REVERSAL_INSUFFICIENT_BALANCE',
      'REFERENCE_NOT_FOUND',
      'REFERENCE_NOT_PROCESSED',
      'INVALID_REFERENCE_KIND',
      'PROVIDER_MISMATCH',
      'PLAYER_MISMATCH',
      'WALLET_MISMATCH',
      'CURRENCY_MISMATCH',
      'ROUND_MISMATCH',
      'REFERENCE_AMOUNT_MISMATCH',
      'REFERENCE_ALREADY_REFUNDED',
      'REFERENCE_ALREADY_ROLLED_BACK',
      'IDEMPOTENCY_CONFLICT',
      'PERMANENT_INFRASTRUCTURE_FAILURE',
    ];
    const sort = (values: string[]) =>
      values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sort(Object.values(FailureCode))).toEqual(sort(expected));
  });
  it('distinguishes BET insufficient funds from credit reversal insufficient funds', () => {
    expect(String(FailureCode.InsufficientBalance)).not.toBe(
      String(FailureCode.ReversalInsufficientBalance),
    );
  });
  it('exposes the enum code on idempotency conflicts independently of the error message', () => {
    const error = new IdempotencyConflictError();
    expect(error.code).toBe(FailureCode.IdempotencyConflict);
    expect(error).toBeInstanceOf(Error);
  });
});
