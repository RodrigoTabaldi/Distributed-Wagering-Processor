import {
  lockWagerForProcessing,
  finishProcessedWager,
} from './wager-processing.js';
import type { MoneyProps } from '../domain/money.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import type { RepositorySession, UnitOfWork } from './ports/repositories.js';

export class InvalidLossError extends Error {
  constructor(public readonly reason: string) {
    super(`Cannot process LOSS: ${reason}`);
    this.name = 'InvalidLossError';
  }
}

export interface ProcessLossResult {
  transactionId: string;
  status: WagerTransactionStatus.Processed;
  balance: MoneyProps;
}

// LOSS registra o desfecho da rodada. O dinheiro da aposta já foi descontado pela BET.
export class ProcessLoss {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(transactionId: string): Promise<ProcessLossResult> {
    return this.unitOfWork.transaction((session) =>
      this.executeInTransaction(session, transactionId),
    );
  }

  async executeInTransaction(
    session: RepositorySession,
    transactionId: string,
  ): Promise<ProcessLossResult> {
    const context = await lockWagerForProcessing(
      session,
      transactionId,
      WagerTransactionKind.Loss,
      InvalidLossError,
    );
    // LOSS confirma somente o resultado; a BET já registrou o débito.
    return finishProcessedWager(session, context);
  }
}
