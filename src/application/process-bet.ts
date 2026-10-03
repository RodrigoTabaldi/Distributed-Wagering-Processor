import { randomUUID } from 'node:crypto';
import type { MoneyProps } from '../domain/money.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import { InsufficientBalanceError } from '../domain/wallet.js';
import {
  FailureCode,
  InvalidTransactionStateError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import type { UnitOfWork } from './ports/repositories.js';

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

// Processa uma BET persistida como PENDING. HTTP/SQS e idempotência serão adapters posteriores.
export class ProcessBet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(transactionId: string): Promise<ProcessBetResult> {
    return this.unitOfWork.transaction(async ({ wallets, wagers, ledger }) => {
      const initial = await wagers.findById(transactionId);
      if (!initial) throw new InvalidBetError('TRANSACTION_NOT_FOUND');
      if (initial.kind !== WagerTransactionKind.Bet)
        throw new InvalidBetError('INVALID_TRANSACTION_KIND');

      // O lock é por wallet, não global: outra wallet pode continuar trabalhando.
      const wallet = await wallets.findByIdForUpdate(initial.walletId);
      if (!wallet) throw new InvalidBetError('WALLET_NOT_FOUND');

      // Após esperar pelo lock, relê o estado: outra execução pode ter terminado esta BET.
      const tx = await wagers.findById(transactionId);
      if (!tx) throw new InvalidBetError('TRANSACTION_NOT_FOUND');
      if (tx.status !== WagerTransactionStatus.Pending)
        throw new InvalidTransactionStateError(tx.status);
      if (tx.walletId !== wallet.id)
        throw new InvalidBetError(FailureCode.WalletMismatch);
      if (tx.playerId !== wallet.playerId)
        throw new InvalidBetError(FailureCode.PlayerMismatch);
      if (tx.money.currency !== wallet.currency)
        throw new InvalidBetError(FailureCode.CurrencyMismatch);

      // Esses vínculos também são protegidos por FK no banco. Dados incompatíveis não são gravados.
      const expectedVersion = wallet.version;
      const at = new Date();
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
        await wagers.updateState(
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

      tx.markProcessed(undefined, at);
      // Valor zero é aceito pelo domínio: não altera saldo/versão e não produz ledger.
      if (entry) {
        await wallets.save(wallet, expectedVersion);
        await ledger.create(entry);
      }
      await wagers.updateState(
        tx,
        WagerTransactionStatus.Pending,
        at,
        wallet.balance,
      );
      // A resposta só sai após o commit; qualquer erro desfaz todas as gravações desta execução.
      return {
        transactionId: tx.id,
        status: WagerTransactionStatus.Processed,
        balance: wallet.balance.toJSON(),
      };
    });
  }
}
