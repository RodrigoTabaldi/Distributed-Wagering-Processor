import { Money } from '../../domain/money.js';
import { InboxMessage } from '../../domain/inbox-message.js';
import { OutboxMessage } from '../../domain/outbox-message.js';
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
  InboxMessageRecord,
  OutboxMessageRecord,
  LedgerEntryRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './entities.js';

export function outboxToRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    // O ORM normaliza objetos recebidos; cópia profunda preserva o envelope imutável do domínio.
    payload: structuredClone(message.payload),
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    publishedAt: message.publishedAt,
  };
}
export function outboxFromRecord(row: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    ...row,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
  });
}

export function inboxToRecord(message: InboxMessage): InboxMessageRecord {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt,
  };
}
export function inboxFromRecord(row: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    ...row,
    processedAt: row.processedAt ?? undefined,
  });
}

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
    correlationId: tx.correlationId,
    causationId: tx.causationId,
    updatedAt,
  };
}
export function transactionFromRecord(
  row: WagerTransactionRecord,
): WagerTransaction {
  // O schema valida kind/status; o domínio valida failureCode ao transicionar.
  // Rehydrate recupera o código salvo sem repetir a rejeição ou a movimentação.
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
