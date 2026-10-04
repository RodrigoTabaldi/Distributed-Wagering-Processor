import {
  lockWagerForProcessing,
  finishProcessedWager,
  resolveWagerReference,
  finishWithoutMovement,
} from './wager-processing.js';
import { randomUUID } from 'node:crypto';
import { InvalidMoneyError, type MoneyProps } from '../domain/money.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import type { RepositorySession, UnitOfWork } from './ports/repositories.js';

export class InvalidWinError extends Error {
  constructor(public readonly reason: string) {
    super(`Cannot process WIN: ${reason}`);
    this.name = 'InvalidWinError';
  }
}
export interface ProcessWinResult {
  transactionId: string;
  status:
    | WagerTransactionStatus.Processed
    | WagerTransactionStatus.Rejected
    | WagerTransactionStatus.PendingReference;
  balance: MoneyProps;
  failureCode?: FailureCode;
}

// Credita o prêmio e registra sua origem; a aposta referenciada não precisa ter o mesmo valor do prêmio.
export class ProcessWin {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  execute(transactionId: string): Promise<ProcessWinResult> {
    return this.unitOfWork.transaction((session) =>
      this.executeInTransaction(session, transactionId),
    );
  }
  async executeInTransaction(
    session: RepositorySession,
    transactionId: string,
  ): Promise<ProcessWinResult> {
    const context = await lockWagerForProcessing(
      session,
      transactionId,
      WagerTransactionKind.Win,
      InvalidWinError,
    );
    const { tx, wallet, at } = context;
    const resolution = await resolveWagerReference(session, tx);
    if (resolution.outcome === 'pending')
      return finishWithoutMovement(session, context);
    if (resolution.outcome === 'rejected')
      return finishWithoutMovement(session, context, resolution.code);
    const referenceId = resolution.reference?.id;
    let entry: WalletLedgerEntry | undefined;
    try {
      // Wallet.credit usa Money exato, incrementa a versão e constrói o ledger antes de alterar o estado.
      entry = wallet.credit({
        entryId: randomUUID(),
        transactionId: tx.id,
        money: tx.money,
        at,
      });
    } catch (error) {
      // Entradas já validadas só podem exceder a capacidade monetária ao somar o prêmio.
      if (!(error instanceof InvalidMoneyError)) throw error;
      return finishWithoutMovement(
        session,
        context,
        FailureCode.BalanceLimitExceeded,
      );
    }
    return finishProcessedWager(session, context, entry, referenceId);
  }
}
