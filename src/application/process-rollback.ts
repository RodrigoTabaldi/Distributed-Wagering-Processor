import {
  lockWagerForProcessing,
  finishProcessedWager,
  resolveWagerReference,
  finishWithoutMovement,
} from './wager-processing.js';
import { randomUUID } from 'node:crypto';
import { InvalidMoneyError, type MoneyProps } from '../domain/money.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { LedgerDirection } from '../domain/wallet-ledger-entry.js';
import { InsufficientBalanceError } from '../domain/wallet.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import type { RepositorySession, UnitOfWork } from './ports/repositories.js';

export class InvalidRollbackError extends Error {
  constructor(public readonly reason: string) {
    super(`Cannot process ROLLBACK: ${reason}`);
    this.name = 'InvalidRollbackError';
  }
}
export interface ProcessRollbackResult {
  transactionId: string;
  status:
    | WagerTransactionStatus.Processed
    | WagerTransactionStatus.Rejected
    | WagerTransactionStatus.PendingReference;
  balance: MoneyProps;
  failureCode?: FailureCode;
}

// Desfaz uma BET, WIN ou REFUND processada, invertendo a direção com o mesmo valor.
export class ProcessRollback {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  execute(transactionId: string): Promise<ProcessRollbackResult> {
    return this.unitOfWork.transaction((session) =>
      this.executeInTransaction(session, transactionId),
    );
  }
  async executeInTransaction(
    session: RepositorySession,
    transactionId: string,
  ): Promise<ProcessRollbackResult> {
    const context = await lockWagerForProcessing(
      session,
      transactionId,
      WagerTransactionKind.Rollback,
      InvalidRollbackError,
    );
    const { tx, wallet, at } = context;
    const resolution = await resolveWagerReference(session, tx);
    if (resolution.outcome === 'pending')
      return finishWithoutMovement(session, context);
    if (resolution.outcome === 'rejected')
      return finishWithoutMovement(session, context, resolution.code);
    const referenceId = resolution.reference?.id;
    // O domínio inverte a direção: BET vira crédito; WIN/REFUND viram débito.
    const direction = tx.ledgerDirectionFor(resolution.reference);
    let entry: WalletLedgerEntry | undefined;
    try {
      const movement = {
        entryId: randomUUID(),
        transactionId: tx.id,
        money: tx.money,
        at,
      };
      // Valor zero não possui efeito financeiro. Nos demais casos usa a regra da Wallet.
      if (direction === LedgerDirection.Credit) entry = wallet.credit(movement);
      else if (direction === LedgerDirection.Debit)
        entry = wallet.debit(movement);
    } catch (error) {
      // Desfazer um crédito exige saldo disponível; o código difere da BET sem saldo.
      if (error instanceof InsufficientBalanceError)
        return finishWithoutMovement(
          session,
          context,
          FailureCode.ReversalInsufficientBalance,
        );
      if (
        error instanceof InvalidMoneyError &&
        direction === LedgerDirection.Credit
      )
        return finishWithoutMovement(
          session,
          context,
          FailureCode.BalanceLimitExceeded,
        );
      // Falhas técnicas propagam para o UnitOfWork desfazer TODAS as gravações.
      throw error;
    }
    return finishProcessedWager(session, context, entry, referenceId);
  }
}
