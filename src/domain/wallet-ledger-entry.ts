import { Money } from './money.js';

// A direção informa se o lançamento retira ou acrescenta dinheiro.
export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

// Dados necessários para registrar uma movimentação e reconstruí-la do banco.
export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

// Histórico imutável: corrigir uma operação exigirá outro lançamento, nunca editar este.
export class WalletLedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly direction: LedgerDirection;
  public readonly money: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;
  readonly #createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;

    // Date é mutável: copiamos na entrada e na saída para proteger o histórico.
    this.#createdAt = new Date(state.createdAt.getTime());
    Object.freeze(this);
  }

  // Só um novo lançamento precisa passar pelas validações de criação.
  static create(state: LedgerEntryState): WalletLedgerEntry {
    for (const id of [state.id, state.walletId, state.transactionId]) {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new InvalidLedgerEntryError(
          'Ledger identifiers must not be empty',
        );
      }
    }
    if (!Object.values(LedgerDirection).includes(state.direction)) {
      throw new InvalidLedgerEntryError('Invalid ledger direction');
    }
    if (!Number.isFinite(state.createdAt.getTime())) {
      throw new InvalidLedgerEntryError('Invalid ledger creation date');
    }
    if (!state.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger amount must be positive');
    }
    if (state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger balances must not be negative');
    }
    const entry = new WalletLedgerEntry(state);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        'Ledger arithmetic does not match balances',
      );
    }
    return entry;
  }

  // Reidratação reconstrói dados persistidos; não executa novamente a operação financeira.
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }

  // Confere saldo anterior + ou - valor = saldo posterior, sempre usando Money.
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
