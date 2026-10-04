import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { wagerPayloadHash, type SubmitWagerInput } from './submit-wager.js';
import { WagerTransactionKind } from '../domain/wager-transaction.js';

const input: SubmitWagerInput = {
  providerId: 'provider',
  externalTransactionId: 'ext',
  playerId: 'player',
  walletId: 'wallet',
  roundId: 'round',
  gameId: 'game',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};

describe('BET canonical payload hash', () => {
  it('includes ROLLBACK kind and its reference in business identity', () => {
    const rollback: SubmitWagerInput = {
      ...input,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'win-a',
    };
    expect(wagerPayloadHash(rollback)).not.toBe(wagerPayloadHash(input));
    expect(wagerPayloadHash(rollback)).not.toBe(
      wagerPayloadHash({
        ...rollback,
        referenceExternalTransactionId: 'win-b',
      }),
    );
  });
  it('includes REFUND kind and its BET reference in business identity', () => {
    const refund: SubmitWagerInput = {
      ...input,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-a',
    };
    expect(wagerPayloadHash(refund)).not.toBe(wagerPayloadHash(input));
    expect(wagerPayloadHash(refund)).not.toBe(
      wagerPayloadHash({ ...refund, referenceExternalTransactionId: 'bet-b' }),
    );
  });
  it('includes LOSS kind in identity even when its amount does not affect the balance', () => {
    const loss: SubmitWagerInput = {
      ...input,
      kind: WagerTransactionKind.Loss,
    };
    expect(wagerPayloadHash(loss)).not.toBe(wagerPayloadHash(input));
    expect(wagerPayloadHash(loss)).not.toBe(
      wagerPayloadHash({ ...loss, money: { amount: '0.00', currency: 'BRL' } }),
    );
  });
  it('includes WIN kind and its optional reference in business identity', () => {
    const win: SubmitWagerInput = { ...input, kind: WagerTransactionKind.Win };
    expect(wagerPayloadHash(win)).not.toBe(wagerPayloadHash(input));
    expect(
      wagerPayloadHash({ ...win, referenceExternalTransactionId: 'bet-a' }),
    ).not.toBe(wagerPayloadHash(win));
    expect(
      wagerPayloadHash({ ...win, referenceExternalTransactionId: 'bet-a' }),
    ).not.toBe(
      wagerPayloadHash({ ...win, referenceExternalTransactionId: 'bet-b' }),
    );
  });
  // Vetor conhecido: define exatamente o formato canônico, incluindo ordenação dos campos aninhados.
  it('uses SHA-256 of the documented canonical business JSON', () => {
    const canonical =
      '{"externalTransactionId":"ext","gameId":"game","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player","providerId":"provider","roundId":"round","walletId":"wallet"}';
    expect(wagerPayloadHash(input)).toBe(
      createHash('sha256').update(canonical).digest('hex'),
    );
  });
  it('ignores property insertion order including the money object', () => {
    const reversed = Object.fromEntries(
      Object.entries(input).reverse(),
    ) as SubmitWagerInput;
    reversed.money = { currency: 'BRL', amount: '25.00' };
    expect(wagerPayloadHash(reversed)).toBe(wagerPayloadHash(input));
  });
  it.each([
    'providerId',
    'externalTransactionId',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
  ] as const)('includes business field %s in identity', (field) => {
    expect(wagerPayloadHash({ ...input, [field]: 'changed' })).not.toBe(
      wagerPayloadHash(input),
    );
  });
  it('includes amount and currency in identity', () => {
    expect(
      wagerPayloadHash({
        ...input,
        money: { amount: '50.00', currency: 'BRL' },
      }),
    ).not.toBe(wagerPayloadHash(input));
    expect(
      wagerPayloadHash({
        ...input,
        money: { amount: '25.00', currency: 'USD' },
      }),
    ).not.toBe(wagerPayloadHash(input));
  });
});
