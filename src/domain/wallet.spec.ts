import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money.js';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
} from './wallet-ledger-entry.js';
import {
  InsufficientBalanceError,
  InvalidWalletError,
  Wallet,
  type WalletMovement,
} from './wallet.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-03T12:00:00.000Z');
const later = new Date('2026-10-03T12:01:00.000Z');
const open = (amount = '100.00') =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
    at,
    opening: { entryId: 'opening-entry', transactionId: 'opening-transaction' },
  });
const movement = (amount: string): WalletMovement => ({
  entryId: 'entry-1',
  transactionId: 'transaction-1',
  money: brl(amount),
  at: later,
});

describe('Wallet', () => {
  // O saldo de abertura precisa ter lastro no ledger, sem incrementar a versão inicial.
  it('opens with version 1 and a credit entry covering the initial balance', () => {
    const { wallet, openingEntry } = open();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt).toEqual(at);
    expect(wallet.updatedAt).toEqual(at);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(openingEntry?.transactionId).toBe('opening-transaction');
    expect(openingEntry?.isBalanced()).toBe(true);
  });

  it('opens an empty wallet without an opening entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('0.00'),
      at,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  // Não permite criar saldo positivo sem os identificadores de sua abertura financeira.
  it('rejects positive opening without ledger identifiers', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), at }),
    ).toThrow(InvalidWalletError);
  });

  it('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('1.00').negate(),
        at,
      }),
    ).toThrow(InvalidWalletError);
  });

  it.each(['id', 'playerId'] as const)('rejects an empty %s', (field) => {
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('0.00'),
        at,
        [field]: ' ',
      }),
    ).toThrow(InvalidWalletError);
  });

  it('rejects an invalid creation date', () => {
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('0.00'),
        at: new Date('invalid'),
      }),
    ).toThrow(InvalidWalletError);
  });

  // Verifica tanto o saldo como o registro retornado, não apenas o resultado aritmético.
  it('debits with a matching ledger entry and increments version', () => {
    const { wallet } = open();
    const entry = wallet.debit(movement('25.00'));
    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(entry?.walletId).toBe(wallet.id);
    expect(entry?.balanceBefore.toString()).toBe('100.00');
    expect(entry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry?.isBalanced()).toBe(true);
  });

  it('credits with a matching ledger entry and increments version', () => {
    const { wallet } = open();
    const entry = wallet.credit(movement('25.00'));
    expect(wallet.balance.toString()).toBe('125.00');
    expect(wallet.version).toBe(2);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.toString()).toBe('100.00');
    expect(entry?.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  it('allows a debit equal to the whole balance', () => {
    const { wallet } = open();
    expect(wallet.debit(movement('100.00'))?.isBalanced()).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
  });

  // Uma rejeição não pode deixar saldo, versão ou data parcialmente alterados.
  it('preserves state when balance is insufficient', () => {
    const { wallet } = open();
    expect(() => wallet.debit(movement('100.01'))).toThrow(
      InsufficientBalanceError,
    );
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(at);
  });

  it.each(['credit', 'debit'] as const)(
    '%s rejects mismatched currencies without mutation',
    (method) => {
      const { wallet } = open();
      expect(() =>
        wallet[method]({
          ...movement('1.00'),
          money: Money.from({ amount: '1.00', currency: 'USD' }),
        }),
      ).toThrow(CurrencyMismatchError);
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
    },
  );

  it.each(['credit', 'debit'] as const)(
    '%s rejects a negative movement',
    (method) => {
      const { wallet } = open();
      expect(() =>
        wallet[method]({ ...movement('1.00'), money: brl('1.00').negate() }),
      ).toThrow(InvalidWalletError);
      expect(wallet.version).toBe(1);
      expect(wallet.balance.toString()).toBe('100.00');
    },
  );

  it.each(['credit', 'debit'] as const)(
    '%s of zero creates no ledger and changes no state',
    (method) => {
      const { wallet } = open();
      expect(wallet[method](movement('0.00'))).toBeUndefined();
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(at);
    },
  );

  it('preserves state if ledger creation fails', () => {
    const { wallet } = open();
    expect(() => wallet.credit({ ...movement('1.00'), entryId: '' })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      wallet.credit({ ...movement('1.00'), at: new Date('invalid') }),
    ).toThrow(InvalidLedgerEntryError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(at);
  });

  it('preserves state when a credit exceeds monetary capacity', () => {
    const { wallet } = open('999999999999999999.99');
    expect(() => wallet.credit(movement('0.01'))).toThrow(InvalidMoneyError);
    expect(wallet.balance.toString()).toBe('999999999999999999.99');
    expect(wallet.version).toBe(1);
  });

  // Reidratar não é abrir novamente: mantém a versão salva e não gera outro crédito.
  it('rehydrates persisted state and continues from its saved version', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('50.00'),
      version: 7,
      createdAt: at,
      updatedAt: later,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('50.00');
    wallet.credit(movement('1.00'));
    expect(wallet.version).toBe(8);
  });

  it('rejects unsafe version increments without modifying balance', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('50.00'),
      version: Number.MAX_SAFE_INTEGER,
      createdAt: at,
      updatedAt: at,
    });
    expect(() => wallet.credit(movement('1.00'))).toThrow(InvalidWalletError);
    expect(wallet.balance.toString()).toBe('50.00');
  });

  // Copiar as datas evita que um chamador altere o estado usando Date.setTime().
  it('protects identity and dates from external mutation', () => {
    const inputAt = new Date(at);
    const { wallet } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('0.00'),
      at: inputAt,
    });
    inputAt.setTime(0);
    wallet.createdAt.setTime(0);
    wallet.updatedAt.setTime(0);
    expect(wallet.createdAt).toEqual(at);
    expect(wallet.updatedAt).toEqual(at);
    expect(Reflect.set(wallet, 'id', 'other')).toBe(false);
    expect(Reflect.set(wallet, 'balance', brl('999.00'))).toBe(false);
  });

  // Reconstrói uma sequência de lançamentos para conferir a consistência final.
  // Este teste é sequencial; concorrência real será testada com PostgreSQL.
  it('keeps balance equal to the sum of its ledger movements', () => {
    const { wallet, openingEntry } = open();
    const entries = [
      openingEntry,
      wallet.debit(movement('80.00')),
      wallet.credit({
        ...movement('25.00'),
        entryId: 'entry-2',
        transactionId: 'transaction-2',
      }),
    ];
    let reconstructed = brl('0.00');
    for (const entry of entries) {
      if (!entry) throw new Error('Expected a financial ledger entry');
      reconstructed =
        entry.direction === LedgerDirection.Credit
          ? reconstructed.add(entry.money)
          : reconstructed.subtract(entry.money);
    }
    expect(wallet.balance.equals(reconstructed)).toBe(true);
    expect(wallet.balance.toString()).toBe('45.00');
    expect(wallet.version).toBe(3);
  });
});
