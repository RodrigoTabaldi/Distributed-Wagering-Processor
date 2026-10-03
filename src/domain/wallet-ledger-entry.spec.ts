import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, Money } from './money.js';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
  type LedgerEntryState,
} from './wallet-ledger-entry.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const state = (): LedgerEntryState => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'transaction-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  createdAt: new Date('2026-10-03T12:00:00.000Z'),
});

describe('WalletLedgerEntry', () => {
  // Toda entrada deve justificar matematicamente a alteração de saldo registrada.
  it('validates a balanced debit', () => {
    const entry = WalletLedgerEntry.create(state());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.transactionId).toBe('transaction-1');
    expect(entry.money.toString()).toBe('25.00');
  });

  it('validates a balanced credit', () => {
    expect(
      WalletLedgerEntry.create({
        ...state(),
        direction: LedgerDirection.Credit,
        balanceAfter: brl('125.00'),
      }).isBalanced(),
    ).toBe(true);
  });

  it.each([LedgerDirection.Debit, LedgerDirection.Credit])(
    'rejects incorrect arithmetic for %s',
    (direction) => {
      expect(() =>
        WalletLedgerEntry.create({
          ...state(),
          direction,
          balanceAfter: brl('99.00'),
        }),
      ).toThrow(InvalidLedgerEntryError);
    },
  );

  it.each(['money', 'balanceBefore', 'balanceAfter'] as const)(
    'rejects a different currency in %s',
    (field) => {
      expect(() =>
        WalletLedgerEntry.create({
          ...state(),
          [field]: Money.from({ amount: '25.00', currency: 'USD' }),
        }),
      ).toThrow(CurrencyMismatchError);
    },
  );

  it.each(['id', 'walletId', 'transactionId'] as const)(
    'rejects an empty %s',
    (field) => {
      expect(() =>
        WalletLedgerEntry.create({ ...state(), [field]: '' }),
      ).toThrow(InvalidLedgerEntryError);
    },
  );

  // Zero não movimenta saldo; valores negativos devem ser expressos pela direção DEBIT.
  it.each([brl('0.00'), brl('1.00').negate()])(
    'rejects non-positive movement amounts',
    (money) => {
      expect(() => WalletLedgerEntry.create({ ...state(), money })).toThrow(
        InvalidLedgerEntryError,
      );
    },
  );

  it.each(['balanceBefore', 'balanceAfter'] as const)(
    'rejects negative %s',
    (field) => {
      expect(() =>
        WalletLedgerEntry.create({ ...state(), [field]: brl('1.00').negate() }),
      ).toThrow(InvalidLedgerEntryError);
    },
  );

  it('rejects an invalid direction and date', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...state(),
        direction: 'INVALID' as LedgerDirection,
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({ ...state(), createdAt: new Date('invalid') }),
    ).toThrow(InvalidLedgerEntryError);
  });

  // Não basta readonly, também protegemos propriedades e datas em execução.
  it('protects the entry and its date against external mutation', () => {
    const input = state();
    const expectedAt = new Date(input.createdAt);
    const entry = WalletLedgerEntry.create(input);
    input.createdAt.setTime(0);
    entry.createdAt.setTime(0);
    expect(entry.createdAt).toEqual(expectedAt);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Reflect.set(entry, 'money', brl('999.00'))).toBe(false);
    expect(entry.money.toString()).toBe('25.00');
  });

  it('rehydrates stored data without recreating a movement', () => {
    const input = state();
    const entry = WalletLedgerEntry.rehydrate(input);
    expect(entry.id).toBe(input.id);
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });
});
