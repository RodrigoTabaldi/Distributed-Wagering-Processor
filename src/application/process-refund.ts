import { persistWagerOutcome } from './persist-wager-outcome.js';
import { randomUUID } from 'node:crypto';
import { InvalidMoneyError, type MoneyProps } from '../domain/money.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import {
  FailureCode,
  InvalidTransactionReferenceError,
  InvalidTransactionStateError,
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
    const { wallets, wagers, ledger } = session;
    const initial = await wagers.findById(transactionId);
    if (!initial) throw new InvalidRefundError('TRANSACTION_NOT_FOUND');
    if (initial.kind !== WagerTransactionKind.Refund)
      throw new InvalidRefundError('INVALID_TRANSACTION_KIND');
    const wallet = await wallets.findByIdForUpdate(initial.walletId);
    if (!wallet) throw new InvalidRefundError('WALLET_NOT_FOUND');
    // Relê após adquirir o lock para não creditar uma transação que outra instância já terminou.
    const tx = await wagers.findById(transactionId);
    if (!tx) throw new InvalidRefundError('TRANSACTION_NOT_FOUND');
    if (
      tx.status !== WagerTransactionStatus.Pending &&
      tx.status !== WagerTransactionStatus.PendingReference
    )
      throw new InvalidTransactionStateError(tx.status);
    if (tx.walletId !== wallet.id)
      throw new InvalidRefundError(FailureCode.WalletMismatch);
    if (tx.playerId !== wallet.playerId)
      throw new InvalidRefundError(FailureCode.PlayerMismatch);
    if (tx.money.currency !== wallet.currency)
      throw new InvalidRefundError(FailureCode.CurrencyMismatch);
    if (tx.referenceExternalTransactionId === undefined)
      throw new InvalidRefundError('REFERENCE_REQUIRED');
    const expectedStatus = tx.status;
    const expectedVersion = wallet.version;
    const at = new Date();
    // Centraliza a persistência de resultados sem movimentação: pendência e rejeição não geram ledger.
    const finishWithoutCredit = async (
      code?: FailureCode,
    ): Promise<ProcessRefundResult> => {
      if (code) tx.reject(code);
      else tx.markPendingReference();
      await persistWagerOutcome(
        session,
        tx,
        expectedStatus,
        at,
        wallet.balance,
      );
      return {
        transactionId: tx.id,
        status: code
          ? WagerTransactionStatus.Rejected
          : WagerTransactionStatus.PendingReference,
        balance: wallet.balance.toJSON(),
        ...(code ? { failureCode: code } : {}),
      };
    };
    let referenceId: string | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      // A referência é resolvida por provedor + ID externo, nunca apenas pelo ID externo.
      const reference = await wagers.findByExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
      if (!reference) return finishWithoutCredit();
      try {
        tx.validateReference(reference);
      } catch (error) {
        if (!(error instanceof InvalidTransactionReferenceError)) throw error;
        // Uma BET existente mas ainda pendente também pode chegar fora de ordem.
        if (
          error.code === FailureCode.ReferenceNotProcessed &&
          !reference.isTerminal()
        )
          return finishWithoutCredit();
        return finishWithoutCredit(error.code);
      }
      // Consulta protegida pelo lock da wallet. Outro REFUND válido dessa BET usa a mesma wallet.
      // O índice UNIQUE processed_reversal_once é a proteção final contra duplicação no banco.
      if (
        await wagers.hasProcessedReversal(
          reference.id,
          WagerTransactionKind.Refund,
        )
      )
        return finishWithoutCredit(FailureCode.ReferenceAlreadyRefunded);
      referenceId = reference.id;
    }
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
      return finishWithoutCredit(FailureCode.BalanceLimitExceeded);
    }
    tx.markProcessed(referenceId, at);
    // BET de valor zero pode ser reembolsada uma vez, sem modificar saldo/versão ou criar ledger.
    if (entry) {
      await wallets.save(wallet, expectedVersion);
      await ledger.create(entry);
    }
    await persistWagerOutcome(session, tx, expectedStatus, at, wallet.balance);
    return {
      transactionId: tx.id,
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance.toJSON(),
    };
  }
}
