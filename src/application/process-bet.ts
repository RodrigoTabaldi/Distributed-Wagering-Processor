import {
  lockWagerForProcessing,
  finishProcessedWager,
} from './wager-processing.js';
import { persistWagerOutcome } from './persist-wager-outcome.js';
import { randomUUID } from 'node:crypto';
import type { MoneyProps } from '../domain/money.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { InsufficientBalanceError } from '../domain/wallet.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import type { RepositorySession, UnitOfWork } from './ports/repositories.js';

// Identifica uma entrada incompatível com este caso de uso, antes de qualquer débito.
export class InvalidBetError extends Error {
  constructor(public readonly reason: string) {
    super(`Cannot process BET: ${reason}`);
    this.name = 'InvalidBetError';
  }
}

export interface ProcessBetResult {
  transactionId: string;
  status: WagerTransactionStatus.Processed | WagerTransactionStatus.Rejected;
  balance: MoneyProps;
  failureCode?: FailureCode;
}

// Processa uma BET PENDING; SubmitWager registra a entrada e controla o replay antes de chamar este fluxo.
export class ProcessBet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(transactionId: string): Promise<ProcessBetResult> {
    return this.unitOfWork.transaction((session) =>
      this.executeInTransaction(session, transactionId),
    );
  }

  // Permite registrar a entrada e processar o débito no MESMO commit, sem transação aninhada.
  async executeInTransaction(
    session: RepositorySession,
    transactionId: string,
  ): Promise<ProcessBetResult> {
    const context = await lockWagerForProcessing(
      session,
      transactionId,
      WagerTransactionKind.Bet,
      InvalidBetError,
    );
    const { tx, wallet, at } = context;
    let entry: WalletLedgerEntry | undefined;
    try {
      // A Wallet calcula o novo saldo com Money, incrementa a versão e produz o lançamento.
      entry = wallet.debit({
        entryId: randomUUID(),
        transactionId: tx.id,
        money: tx.money,
        at,
      });
    } catch (error) {
      // Só saldo insuficiente vira rejeição de negócio; falhas técnicas causam rollback.
      if (!(error instanceof InsufficientBalanceError)) throw error;
      tx.reject(FailureCode.InsufficientBalance);
      await persistWagerOutcome(
        session,
        tx,
        WagerTransactionStatus.Pending,
        at,
        wallet.balance,
      );
      return {
        transactionId: tx.id,
        status: WagerTransactionStatus.Rejected,
        balance: wallet.balance.toJSON(),
        failureCode: FailureCode.InsufficientBalance,
      };
    }

    return finishProcessedWager(session, context, entry);
  }
}
