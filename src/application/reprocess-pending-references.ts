import { persistWagerOutcome } from './persist-wager-outcome.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import { ProcessWin } from './process-win.js';
import { ProcessRefund } from './process-refund.js';
import { ProcessRollback } from './process-rollback.js';
import {
  REFERENCE_RETRY_POLICY,
  referenceRetryDelay,
} from './reference-retry-policy.js';
import type { UnitOfWork } from './ports/repositories.js';

export type ReferenceRetryOutcome =
  'skipped' | 'processed' | 'rejected' | 'rescheduled';
export type ReferenceRetryResult =
  | { transactionId: string; outcome: ReferenceRetryOutcome }
  | { transactionId: string; outcome: 'failed'; error: unknown };

export class ReprocessPendingReferences {
  constructor(private readonly unitOfWork: UnitOfWork) {}
  async runDue(
    now = new Date(),
    signal?: AbortSignal,
  ): Promise<ReferenceRetryResult[]> {
    const ids = await this.unitOfWork.read(({ pendingReferences }) =>
      pendingReferences.findDue(now, REFERENCE_RETRY_POLICY.batchSize),
    );
    const results: ReferenceRetryResult[] = [];
    // Isola falhas por operação: uma pendência com erro não impede as demais wallets.
    for (const id of ids) {
      if (signal?.aborted) break;
      try {
        results.push({
          transactionId: id,
          outcome: await this.runOne(id, now, signal),
        });
      } catch (error) {
        results.push({ transactionId: id, outcome: 'failed', error });
      }
    }
    return results;
  }
  async runOne(
    id: string,
    now = new Date(),
    signal?: AbortSignal,
  ): Promise<ReferenceRetryOutcome> {
    if (!Number.isFinite(now.getTime()))
      throw new Error('Invalid reference retry date');
    return this.unitOfWork.transaction(async (session) => {
      const initial = await session.wagers.findById(id);
      if (
        !initial ||
        initial.status !== WagerTransactionStatus.PendingReference
      )
        return 'skipped';
      // Ordem wallet → transação é a mesma da API. SKIP LOCKED evita esperar por outra execução.
      const wallet = await session.wallets.findByIdForUpdateSkipLocked(
        initial.walletId,
      );
      if (!wallet) return 'skipped';
      const tx = await session.wagers.findById(id);
      if (!tx || tx.status !== WagerTransactionStatus.PendingReference)
        return 'skipped';
      const schedule = await session.pendingReferences.findSchedule(id);
      // Revalida o vencimento após o lock: outro worker pode ter terminado ou reagendado a operação.
      if (!schedule || schedule.nextAttemptAt > now) return 'skipped';
      const attempts = schedule.attempts + 1;
      session.recordAfterCommit?.({
        type: 'retry',
        source: 'reference',
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        correlationId: tx.correlationId ?? tx.id,
      });
      await session.pendingReferences.reschedule(
        id,
        attempts,
        new Date(now.getTime() + referenceRetryDelay(attempts)),
      );
      // Retoma a regra original com o MESMO ID, hash e chave, sem registrar outra operação.
      let processor: ProcessWin | ProcessRefund | ProcessRollback;
      switch (tx.kind) {
        case WagerTransactionKind.Win:
          processor = new ProcessWin(this.unitOfWork);
          break;
        case WagerTransactionKind.Refund:
          processor = new ProcessRefund(this.unitOfWork);
          break;
        case WagerTransactionKind.Rollback:
          processor = new ProcessRollback(this.unitOfWork);
          break;
        default:
          throw new Error('Unsupported pending reference operation');
      }
      const result = await processor.executeInTransaction(session, id);
      if (result.status === WagerTransactionStatus.Processed)
        return 'processed';
      if (result.status === WagerTransactionStatus.Rejected) return 'rejected';
      // A última tentativa ainda pode processar uma referência que acabou de chegar.
      const expired =
        now.getTime() - tx.createdAt.getTime() >= REFERENCE_RETRY_POLICY.ttlMs;
      if (attempts >= REFERENCE_RETRY_POLICY.maxAttempts || expired) {
        const pending = await session.wagers.findById(id);
        if (!pending)
          throw new Error('Pending reference transaction disappeared');
        const reference = await session.wagers.findByExternalId(
          tx.providerId,
          tx.referenceExternalTransactionId!,
        );
        pending.reject(
          reference
            ? FailureCode.ReferenceNotProcessed
            : FailureCode.ReferenceNotFound,
        );
        await persistWagerOutcome(
          session,
          pending,
          WagerTransactionStatus.PendingReference,
          now,
          wallet.balance,
        );
        return 'rejected';
      }
      // Tentativas, agenda e eventual saldo/ledger compartilham o commit. Falhas técnicas desfazem tudo.
      return 'rescheduled';
    }, signal);
  }
}
