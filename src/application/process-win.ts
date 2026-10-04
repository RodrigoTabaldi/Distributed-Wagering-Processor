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
    const { wallets, wagers, ledger } = session;
    const initial = await wagers.findById(transactionId);
    if (!initial) throw new InvalidWinError('TRANSACTION_NOT_FOUND');
    if (initial.kind !== WagerTransactionKind.Win)
      throw new InvalidWinError('INVALID_TRANSACTION_KIND');
    const wallet = await wallets.findByIdForUpdate(initial.walletId);
    if (!wallet) throw new InvalidWinError('WALLET_NOT_FOUND');
    // Relê após adquirir o lock para não creditar uma transação que outra instância já terminou.
    const tx = await wagers.findById(transactionId);
    if (!tx) throw new InvalidWinError('TRANSACTION_NOT_FOUND');
    if (
      tx.status !== WagerTransactionStatus.Pending &&
      tx.status !== WagerTransactionStatus.PendingReference
    )
      throw new InvalidTransactionStateError(tx.status);
    if (tx.walletId !== wallet.id)
      throw new InvalidWinError(FailureCode.WalletMismatch);
    if (tx.playerId !== wallet.playerId)
      throw new InvalidWinError(FailureCode.PlayerMismatch);
    if (tx.money.currency !== wallet.currency)
      throw new InvalidWinError(FailureCode.CurrencyMismatch);
    const expectedStatus = tx.status;
    const expectedVersion = wallet.version;
    const at = new Date();
    // Centraliza a persistência de resultados sem movimentação: pendência e rejeição não geram ledger.
    const finishWithoutCredit = async (
      code?: FailureCode,
    ): Promise<ProcessWinResult> => {
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
      referenceId = reference.id;
    }
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
      return finishWithoutCredit(FailureCode.BalanceLimitExceeded);
    }
    tx.markProcessed(referenceId, at);
    // Prêmio zero registra o resultado, mas não modifica saldo/versão nem cria lançamento.
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
