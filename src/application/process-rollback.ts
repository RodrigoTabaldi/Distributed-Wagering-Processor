import { randomUUID } from 'node:crypto';
import { InvalidMoneyError, type MoneyProps } from '../domain/money.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { LedgerDirection } from '../domain/wallet-ledger-entry.js';
import { InsufficientBalanceError } from '../domain/wallet.js';
import {
  FailureCode,
  InvalidTransactionReferenceError,
  InvalidTransactionStateError,
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
    { wallets, wagers, ledger }: RepositorySession,
    transactionId: string,
  ): Promise<ProcessRollbackResult> {
    const initial = await wagers.findById(transactionId);
    if (!initial) throw new InvalidRollbackError('TRANSACTION_NOT_FOUND');
    if (initial.kind !== WagerTransactionKind.Rollback)
      throw new InvalidRollbackError('INVALID_TRANSACTION_KIND');
    const wallet = await wallets.findByIdForUpdate(initial.walletId);
    if (!wallet) throw new InvalidRollbackError('WALLET_NOT_FOUND');
    // Relê após adquirir o lock para não creditar uma transação que outra instância já terminou.
    const tx = await wagers.findById(transactionId);
    if (!tx) throw new InvalidRollbackError('TRANSACTION_NOT_FOUND');
    if (
      tx.status !== WagerTransactionStatus.Pending &&
      tx.status !== WagerTransactionStatus.PendingReference
    )
      throw new InvalidTransactionStateError(tx.status);
    if (tx.walletId !== wallet.id)
      throw new InvalidRollbackError(FailureCode.WalletMismatch);
    if (tx.playerId !== wallet.playerId)
      throw new InvalidRollbackError(FailureCode.PlayerMismatch);
    if (tx.money.currency !== wallet.currency)
      throw new InvalidRollbackError(FailureCode.CurrencyMismatch);
    if (tx.referenceExternalTransactionId === undefined)
      throw new InvalidRollbackError('REFERENCE_REQUIRED');
    const expectedStatus = tx.status;
    const expectedVersion = wallet.version;
    const at = new Date();
    // Centraliza a persistência de resultados sem movimentação: pendência e rejeição não geram ledger.
    const finishWithoutMovement = async (
      code?: FailureCode,
    ): Promise<ProcessRollbackResult> => {
      if (code) tx.reject(code);
      else tx.markPendingReference();
      await wagers.updateState(tx, expectedStatus, at, wallet.balance);
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
    let direction: LedgerDirection | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      // A referência é resolvida por provedor + ID externo, nunca apenas pelo ID externo.
      const reference = await wagers.findByExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
      if (!reference) return finishWithoutMovement();
      try {
        tx.validateReference(reference);
      } catch (error) {
        if (!(error instanceof InvalidTransactionReferenceError)) throw error;
        // Uma referência existente mas ainda pendente também pode chegar fora de ordem.
        if (
          error.code === FailureCode.ReferenceNotProcessed &&
          !reference.isTerminal()
        )
          return finishWithoutMovement();
        return finishWithoutMovement(error.code);
      }
      // Consulta protegida pelo lock da wallet. Outro ROLLBACK válido dessa referência usa a mesma wallet.
      // O índice UNIQUE processed_reversal_once é a proteção final contra duplicação no banco.
      if (
        await wagers.hasProcessedReversal(
          reference.id,
          WagerTransactionKind.Rollback,
        )
      )
        return finishWithoutMovement(FailureCode.ReferenceAlreadyRolledBack);
      referenceId = reference.id;
      // BET originalmente debita; WIN/REFUND creditam. O domínio determina a direção inversa.
      direction = tx.ledgerDirectionFor(reference);
    }
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
        return finishWithoutMovement(FailureCode.ReversalInsufficientBalance);
      if (
        error instanceof InvalidMoneyError &&
        direction === LedgerDirection.Credit
      )
        return finishWithoutMovement(FailureCode.BalanceLimitExceeded);
      // Falhas técnicas propagam para o UnitOfWork desfazer TODAS as gravações.
      throw error;
    }
    tx.markProcessed(referenceId, at);
    // Referência de valor zero pode ser revertida uma vez, sem alterar saldo/versão ou criar ledger.
    if (entry) {
      await wallets.save(wallet, expectedVersion);
      await ledger.create(entry);
    }
    await wagers.updateState(tx, expectedStatus, at, wallet.balance);
    return {
      transactionId: tx.id,
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance.toJSON(),
    };
  }
}
