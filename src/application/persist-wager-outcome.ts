import { randomUUID } from 'node:crypto';
import type { RepositorySession } from './ports/repositories.js';
import type { Money } from '../domain/money.js';
import { OutboxMessage } from '../domain/outbox-message.js';
import {
  WagerTransaction,
  WagerTransactionStatus as Status,
} from '../domain/wager-transaction.js';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WagerTransactionFailed,
  WalletBalanceChanged,
  type WagerEventData,
} from '../domain/wager-events.js';

// Estado e eventos são gravados na MESMA sessão SQL; esta função nunca acessa SQS.
export async function persistWagerOutcome(
  session: RepositorySession,
  tx: WagerTransaction,
  expected: Status,
  at: Date,
  balance: Money,
): Promise<void> {
  await session.wagers.updateState(tx, expected, at, balance);
  if (tx.status !== expected)
    await enqueueWagerEvents(session, tx, at, balance);
}
export async function enqueueWagerEvents(
  session: RepositorySession,
  tx: WagerTransaction,
  at: Date,
  balance: Money,
): Promise<void> {
  session.recordAfterCommit?.({
    type: 'transaction',
    status: tx.status,
    transactionId: tx.id,
    walletId: tx.walletId,
    providerId: tx.providerId,
    correlationId: tx.correlationId ?? tx.id,
    ...(tx.causationId ? { messageId: tx.causationId } : {}),
  });
  const data: WagerEventData = {
    transactionId: tx.id,
    externalTransactionId: tx.externalTransactionId,
    providerId: tx.providerId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    balance: balance.toJSON(),
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
  };
  const props = {
    eventId: randomUUID(),
    aggregateId: tx.id,
    correlationId: tx.correlationId ?? tx.id,
    ...(tx.causationId ? { causationId: tx.causationId } : {}),
    occurredAt: at,
    data,
  };
  const event =
    tx.status === Status.Processed
      ? new WagerTransactionProcessed(props)
      : tx.status === Status.Rejected
        ? new WagerTransactionRejected(props)
        : tx.status === Status.PendingReference
          ? new WagerTransactionPendingReference(props)
          : tx.status === Status.Failed
            ? new WagerTransactionFailed(props)
            : undefined;
  if (event) await session.outbox.create(OutboxMessage.enqueue(event));
  // LOSS, valor zero, rejeição e pendência não têm ledger: não geram alteração de saldo.
  const entry =
    tx.status === Status.Processed
      ? await session.ledger.findByTransaction(tx.walletId, tx.id)
      : undefined;
  if (entry && !entry.balanceBefore.equals(entry.balanceAfter)) {
    // A versão identifica esta mudança mesmo quando publishers entregam eventos fora de ordem.
    const wallet = await session.wallets.findByIdForUpdate(tx.walletId);
    if (!wallet) throw new Error('Event wallet disappeared');
    await session.outbox.create(
      OutboxMessage.enqueue(
        new WalletBalanceChanged({
          ...props,
          eventId: randomUUID(),
          aggregateId: tx.walletId,
          data: {
            transactionId: tx.id,
            walletId: tx.walletId,
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            direction: entry.direction,
            money: entry.money.toJSON(),
            walletVersion: wallet.version,
          },
        }),
      ),
    );
  }
}
