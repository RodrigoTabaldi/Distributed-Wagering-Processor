import { persistWagerOutcome } from './persist-wager-outcome.js';
import type { MoneyProps } from '../domain/money.js';
import {
  FailureCode,
  InvalidTransactionStateError,
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
    const { wallets, wagers } = session;
    const initial = await wagers.findById(transactionId);
    if (!initial) throw new InvalidLossError('TRANSACTION_NOT_FOUND');
    if (initial.kind !== WagerTransactionKind.Loss)
      throw new InvalidLossError('INVALID_TRANSACTION_KIND');

    // O lock torna o saldo observado consistente com as BETs/WINs da mesma wallet.
    // Ele não altera a wallet e não bloqueia wallets diferentes.
    const wallet = await wallets.findByIdForUpdate(initial.walletId);
    if (!wallet) throw new InvalidLossError('WALLET_NOT_FOUND');
    const tx = await wagers.findById(transactionId);
    if (!tx) throw new InvalidLossError('TRANSACTION_NOT_FOUND');
    if (tx.status !== WagerTransactionStatus.Pending)
      throw new InvalidTransactionStateError(tx.status);
    if (tx.walletId !== wallet.id)
      throw new InvalidLossError(FailureCode.WalletMismatch);
    if (tx.playerId !== wallet.playerId)
      throw new InvalidLossError(FailureCode.PlayerMismatch);
    if (tx.money.currency !== wallet.currency)
      throw new InvalidLossError(FailureCode.CurrencyMismatch);

    const at = new Date();
    tx.markProcessed(undefined, at);
    // Grava somente o resultado e o saldo observado para replay; não chama debit, credit ou save.
    // Mesmo que o payload tenha valor positivo, LOSS não representa movimentação financeira.
    await persistWagerOutcome(
      session,
      tx,
      WagerTransactionStatus.Pending,
      at,
      wallet.balance,
    );
    return {
      transactionId: tx.id,
      status: WagerTransactionStatus.Processed,
      balance: wallet.balance.toJSON(),
    };
  }
}
