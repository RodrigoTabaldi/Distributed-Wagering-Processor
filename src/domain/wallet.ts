import { CurrencyMismatchError, Money } from './money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// A aplicação fornece os identificadores e a data.
export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  opening?: { entryId: string; transactionId: string };
}

export interface WalletOpening {
  wallet: Wallet;
  openingEntry?: WalletLedgerEntry;
}

export class InvalidWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletError';
  }
}
// Erro de Saldo insuficinte para debito.

export class InsufficientBalanceError extends Error {
  constructor() {
    super('Wallet has insufficient balance');
    this.name = 'InsufficientBalanceError';
  }
}

// Aggregate Root: a Wallet controla as mudanças de seu próprio saldo.
export class Wallet {
  public readonly id: string;
  public readonly playerId: string;
  public readonly currency: string;
  #balance: Money;
  #version: number;
  readonly #createdAt: Date;
  #updatedAt: Date;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this.#balance = state.balance;
    this.#version = state.version;
    this.#createdAt = new Date(state.createdAt.getTime());
    this.#updatedAt = new Date(state.updatedAt.getTime());
    // Congela a identidade pública. Campos # continuam mutáveis pelos métodos da classe.
    Object.freeze(this);
  }

  // Retorna a wallet e seu lançamento inicial para a aplicação persistir ambos juntos.
  // O registro da transação OPENING será implementado na camada de aplicação.
  static open(props: OpenWalletProps): WalletOpening {
    if (!props.id?.trim() || !props.playerId?.trim()) {
      throw new InvalidWalletError(
        'Wallet and player identifiers must not be empty',
      );
    }
    if (!Number.isFinite(props.at.getTime())) {
      throw new InvalidWalletError('Invalid wallet creation date');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('Initial balance must not be negative');
    }
    let openingEntry: WalletLedgerEntry | undefined;
    if (props.initialBalance.isPositive()) {
      if (!props.opening) {
        throw new InvalidWalletError(
          'Positive initial balance requires opening identifiers',
        );
      }
      openingEntry = WalletLedgerEntry.create({
        id: props.opening.entryId,
        transactionId: props.opening.transactionId,
        walletId: props.id,
        direction: LedgerDirection.Credit,
        money: props.initialBalance,
        balanceBefore: Money.zero(props.initialBalance.currency),
        balanceAfter: props.initialBalance,
        createdAt: props.at,
      });
    }
    const wallet = new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: props.at,
      updatedAt: props.at,
    });
    return { wallet, openingEntry };
  }

  // Reconstitui o estado salvo sem criar abertura, incrementar versão ou movimentar saldo.
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get balance(): Money {
    return this.#balance;
  }
  get version(): number {
    return this.#version;
  }
  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }
  get updatedAt(): Date {
    return new Date(this.#updatedAt.getTime());
  }

  // Retorna o lançamento correspondente ao débito; saldo insuficiente gera erro.
  debit(movement: WalletMovement): WalletLedgerEntry | undefined {
    return this.move(movement, LedgerDirection.Debit);
  }

  // Retorna o lançamento correspondente ao crédito.
  credit(movement: WalletMovement): WalletLedgerEntry | undefined {
    return this.move(movement, LedgerDirection.Credit);
  }

  // Centraliza as garantias comuns a crédito e débito, sem duplicar as regras.
  private move(
    movement: WalletMovement,
    direction: LedgerDirection,
  ): WalletLedgerEntry | undefined {
    this.assertSameCurrency(movement.money);
    if (movement.money.isNegative()) {
      throw new InvalidWalletError('Movement amount must not be negative');
    }
    if (movement.money.isZero()) return undefined;
    if (
      !Number.isSafeInteger(this.#version) ||
      this.#version >= Number.MAX_SAFE_INTEGER
    ) {
      throw new InvalidWalletError(
        'Wallet version cannot be incremented safely',
      );
    }
    if (
      direction === LedgerDirection.Debit &&
      this.#balance.isLessThan(movement.money)
    ) {
      throw new InsufficientBalanceError();
    }
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? this.#balance.subtract(movement.money)
        : this.#balance.add(movement.money);
    // Valida o lançamento ANTES de modificar a wallet, uma falha preserva todo o estado.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      transactionId: movement.transactionId,
      walletId: this.id,
      direction,
      money: movement.money,
      balanceBefore: this.#balance,
      balanceAfter,
      createdAt: movement.at,
    });
    this.#balance = balanceAfter;
    this.#version += 1;
    this.#updatedAt = new Date(movement.at.getTime());
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
