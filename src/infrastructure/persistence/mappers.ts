import { Money } from '../../domain/money.js';
import { Wallet } from '../../domain/wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/wallet-ledger-entry.js';
import {
  WagerTransaction,
  type FailureCode,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction.js';
import type {
  LedgerEntryRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entities.js';

// Traduz domínio → colunas sem expor Decimal ou campos privados ao ORM.
export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
export function walletFromRecord(row: WalletRecord): Wallet {
  return Wallet.rehydrate({
    ...row,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
  });
}
export function transactionToRecord(
  tx: WagerTransaction,
  updatedAt: Date,
): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.toString(),
    currency: tx.money.currency,
    status: tx.status,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    processedAt: tx.processedAt,
    createdAt: tx.createdAt,
    updatedAt,
  };
}
export function transactionFromRecord(
  row: WagerTransactionRecord,
): WagerTransaction {
  // O schema valida os enums; rehydrate não executa novamente regras de transição.
  return WagerTransaction.rehydrate({
    ...row,
    kind: row.kind as WagerTransactionKind,
    status: row.status as WagerTransactionStatus,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId:
      row.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: row.processedAt ?? undefined,
  });
}
export function ledgerToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    createdAt: entry.createdAt,
  };
}
export function ledgerFromRecord(row: LedgerEntryRecord): WalletLedgerEntry {
  const money = (amount: string) =>
    Money.from({ amount, currency: row.currency });
  return WalletLedgerEntry.rehydrate({
    ...row,
    direction: row.direction as LedgerDirection,
    money: money(row.amount),
    balanceBefore: money(row.balanceBefore),
    balanceAfter: money(row.balanceAfter),
  });
}
