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

export class InvalidRefundError extends Error {
  constructor(public readonly reason: string) {
    super(`Cannot process REFUND: ${reason}`);
    this.name = 'InvalidRefundError';
  }
}
export interface ProcessRefundResult {
  transactionId: string;
  status:
    | WagerTransactionStatus.Processed
    | WagerTransactionStatus.Rejected
    | WagerTransactionStatus.PendingReference;
  balance: MoneyProps;
  failureCode?: FailureCode;
}

// Devolve integralmente uma BET processada; o valor precisa ser igual ao da aposta original.
export class ProcessRefund {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  execute(transactionId: string): Promise<ProcessRefundResult> {
    return this.unitOfWork.transaction((session) =>
      this.executeInTransaction(session, transactionId),
    );
  }
  async executeInTransaction(
    session: RepositorySession,
    transactionId: string,
  ): Promise<ProcessRefundResult> {
    const context = await lockWagerForProcessing(
      session,
      transactionId,
      WagerTransactionKind.Refund,
      InvalidRefundError,
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
      // Wallet.credit devolve o valor exato e constrói o CREDIT antes de alterar o saldo.
      entry = wallet.credit({
        entryId: randomUUID(),
        transactionId: tx.id,
        money: tx.money,
        at,
      });
    } catch (error) {
      // Entradas já validadas só podem exceder a capacidade monetária ao somar a devolução.
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
