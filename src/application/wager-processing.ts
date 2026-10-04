import type { Wallet } from '../domain/wallet.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import type { MoneyProps } from '../domain/money.js';
import {
  FailureCode,
  InvalidTransactionReferenceError,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../domain/wager-transaction.js';
import type { RepositorySession } from './ports/repositories.js';
import { persistWagerOutcome } from './persist-wager-outcome.js';

export interface WagerProcessingContext {
  tx: WagerTransaction;
  wallet: Wallet;
  expectedStatus: Status;
  expectedVersion: number;
  at: Date;
}

// Compartilha a proteção transacional; cada processador continua explicando sua regra financeira.
export async function lockWagerForProcessing(
  session: RepositorySession,
  transactionId: string,
  kind: Kind,
  InvalidInput: new (reason: string) => Error,
): Promise<WagerProcessingContext> {
  const initial = await session.wagers.findById(transactionId);
  if (!initial) throw new InvalidInput('TRANSACTION_NOT_FOUND');
  if (initial.kind !== kind) throw new InvalidInput('INVALID_TRANSACTION_KIND');
  const wallet = await session.wallets.findByIdForUpdate(initial.walletId);
  if (!wallet) throw new InvalidInput('WALLET_NOT_FOUND');
  // A leitura anterior ao lock pode estar desatualizada: reler impede aplicar um resultado terminal.
  const tx = await session.wagers.findById(transactionId);
  if (!tx) throw new InvalidInput('TRANSACTION_NOT_FOUND');
  const canAwaitReference = [Kind.Win, Kind.Refund, Kind.Rollback].includes(
    kind,
  );
  if (
    tx.status !== Status.Pending &&
    !(canAwaitReference && tx.status === Status.PendingReference)
  )
    throw new InvalidTransactionStateError(tx.status);
  if (tx.walletId !== wallet.id)
    throw new InvalidInput(FailureCode.WalletMismatch);
  if (tx.playerId !== wallet.playerId)
    throw new InvalidInput(FailureCode.PlayerMismatch);
  if (tx.money.currency !== wallet.currency)
    throw new InvalidInput(FailureCode.CurrencyMismatch);
  if (tx.requiresReference() && tx.referenceExternalTransactionId === undefined)
    throw new InvalidInput('REFERENCE_REQUIRED');
  return {
    tx,
    wallet,
    expectedStatus: tx.status,
    expectedVersion: wallet.version,
    at: new Date(),
  };
}

type ReferenceResolution =
  | { outcome: 'resolved'; reference?: WagerTransaction }
  | { outcome: 'pending' }
  | { outcome: 'rejected'; code: FailureCode };

export async function resolveWagerReference(
  session: RepositorySession,
  tx: WagerTransaction,
): Promise<ReferenceResolution> {
  if (tx.referenceExternalTransactionId === undefined)
    return { outcome: 'resolved' };
  const reference = await session.wagers.findByExternalId(
    tx.providerId,
    tx.referenceExternalTransactionId,
  );
  if (!reference) return { outcome: 'pending' };
  try {
    tx.validateReference(reference);
  } catch (error) {
    if (!(error instanceof InvalidTransactionReferenceError)) throw error;
    // Uma origem pendente ainda pode chegar a PROCESSED. Uma origem terminal inválida não pode.
    if (
      error.code === FailureCode.ReferenceNotProcessed &&
      !reference.isTerminal()
    )
      return { outcome: 'pending' };
    return { outcome: 'rejected', code: error.code };
  }
  // O chamador já possui o lock da wallet; o índice UNIQUE é a arbitragem final entre instâncias.
  if (
    (tx.kind === Kind.Refund || tx.kind === Kind.Rollback) &&
    (await session.wagers.hasProcessedReversal(reference.id, tx.kind))
  )
    return {
      outcome: 'rejected',
      code:
        tx.kind === Kind.Refund
          ? FailureCode.ReferenceAlreadyRefunded
          : FailureCode.ReferenceAlreadyRolledBack,
    };
  return { outcome: 'resolved', reference };
}

export async function finishWithoutMovement(
  session: RepositorySession,
  context: WagerProcessingContext,
  code?: FailureCode,
): Promise<{
  transactionId: string;
  status: Status.Rejected | Status.PendingReference;
  balance: MoneyProps;
  failureCode?: FailureCode;
}> {
  const { tx, wallet, expectedStatus, at } = context;
  if (code) tx.reject(code);
  else tx.markPendingReference();
  await persistWagerOutcome(session, tx, expectedStatus, at, wallet.balance);
  return {
    transactionId: tx.id,
    status: code ? Status.Rejected : Status.PendingReference,
    balance: wallet.balance.toJSON(),
    ...(code ? { failureCode: code } : {}),
  };
}

export async function finishProcessedWager(
  session: RepositorySession,
  context: WagerProcessingContext,
  entry?: WalletLedgerEntry,
  referenceId?: string,
): Promise<{
  transactionId: string;
  status: Status.Processed;
  balance: MoneyProps;
}> {
  const { tx, wallet, expectedVersion, expectedStatus, at } = context;
  tx.markProcessed(referenceId, at);
  // LOSS e valores zero não têm movimento. Saldo, versão e ledger só mudam juntos.
  if (entry) {
    await session.wallets.save(wallet, expectedVersion);
    await session.ledger.create(entry);
  }
  await persistWagerOutcome(session, tx, expectedStatus, at, wallet.balance);
  return {
    transactionId: tx.id,
    status: Status.Processed,
    balance: wallet.balance.toJSON(),
  };
}
