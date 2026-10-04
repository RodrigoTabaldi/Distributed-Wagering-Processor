import { createHash, randomUUID } from 'node:crypto';
import { Money, type MoneyProps } from '../domain/money.js';
import {
  IdempotencyConflictError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import { InvalidBetError, ProcessBet } from './process-bet.js';
import { ProcessWin, type ProcessWinResult } from './process-win.js';
import { ProcessLoss } from './process-loss.js';
import { ProcessRefund } from './process-refund.js';
import { ProcessRollback } from './process-rollback.js';
import type { RepositorySession, UnitOfWork } from './ports/repositories.js';

export interface WagerEventContext {
  correlationId: string;
  causationId?: string;
}
export interface SubmitWagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind:
    | WagerTransactionKind.Bet
    | WagerTransactionKind.Win
    | WagerTransactionKind.Loss
    | WagerTransactionKind.Refund
    | WagerTransactionKind.Rollback;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}
export interface SubmitWagerResult extends ProcessWinResult {
  idempotentReplay: boolean;
}

// Serializa apenas o contrato validado: ordena chaves recursivamente, inclusive dentro de Money.
// Arrays não fazem parte deste contrato. Header, IDs internos e datas ficam fora do hash.
export function wagerPayloadHash(input: SubmitWagerInput): string {
  const canonical = (value: unknown): string => {
    if (value !== null && typeof value === 'object') {
      const fields = value as Record<string, unknown>;
      return `{${Object.keys(fields)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };
  return createHash('sha256').update(canonical(input)).digest('hex');
}

// Resultado terminal sem saldo salvo indica inconsistência; nunca inventa um saldo de replay.
export class StoredResultUnavailableError extends Error {
  constructor() {
    super('Original transaction result is unavailable');
    this.name = 'StoredResultUnavailableError';
  }
}

export class SubmitWager {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(
    input: SubmitWagerInput,
    key: string,
    context?: WagerEventContext,
  ): Promise<SubmitWagerResult> {
    const { tx, payload, hash } = this.prepare(input, key, context);
    try {
      return await this.unitOfWork.transaction((session) =>
        this.process(session, tx, payload, key, hash),
      );
    } catch (error) {
      // Chaves iguais podem disputar wallets diferentes. UNIQUE é a arbitragem final no banco.
      // Após 23505, a transação está abortada: consulta o vencedor em uma NOVA transação.
      if (!this.isIdentityRace(error)) throw error;
      return this.unitOfWork.transaction(async (session) => {
        const existing = await this.existing(session, key, payload);
        if (!existing) throw error;
        return this.replay(session, existing, key, hash);
      });
    }
  }

  // Inbox e HTTP usam a mesma regra. A Inbox fornece sua sessão para evitar commit separado.
  async executeInTransaction(
    session: RepositorySession,
    input: SubmitWagerInput,
    key: string,
    context?: WagerEventContext,
  ): Promise<SubmitWagerResult> {
    const { tx, payload, hash } = this.prepare(input, key, context);
    return this.process(session, tx, payload, key, hash);
  }
  private prepare(
    input: SubmitWagerInput,
    key: string,
    context?: WagerEventContext,
  ) {
    if (typeof key !== 'string' || !key.trim() || key.trim() !== key)
      throw new InvalidBetError('INVALID_IDEMPOTENCY_KEY');
    if (
      input.kind !== WagerTransactionKind.Bet &&
      input.kind !== WagerTransactionKind.Win &&
      input.kind !== WagerTransactionKind.Loss &&
      input.kind !== WagerTransactionKind.Refund &&
      input.kind !== WagerTransactionKind.Rollback
    )
      throw new InvalidBetError('INVALID_TRANSACTION_KIND');
    const money = Money.from(input.money);
    // Reconstrói explicitamente o subconjunto de negócio, descartando metadados de transporte.
    const payload: SubmitWagerInput = {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId.toLowerCase(),
      walletId: input.walletId.toLowerCase(),
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      ...(input.referenceExternalTransactionId !== undefined
        ? {
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
          }
        : {}),
    };
    const hash = wagerPayloadHash(payload);
    const tx = WagerTransaction.create({
      ...payload,
      correlationId: context?.correlationId,
      causationId: context?.causationId,
      id: randomUUID(),
      idempotencyKey: key,
      payloadHash: hash,
      money,
      createdAt: new Date(),
    });
    return { tx, payload, hash };
  }
  private async process(
    session: RepositorySession,
    tx: WagerTransaction,
    payload: SubmitWagerInput,
    key: string,
    hash: string,
  ): Promise<SubmitWagerResult> {
    const existing = await this.existing(session, key, payload);
    if (existing) return this.replay(session, existing, key, hash);
    // Mantém a ordem wallet → gravações financeiras, compatível com o processamento existente.
    const wallet = await session.wallets.findByIdForUpdate(tx.walletId);
    if (!wallet) throw new InvalidBetError('WALLET_NOT_FOUND');
    // Outra instância pode ter confirmado esta chave enquanto esperávamos o lock.
    const afterLock = await this.existing(session, key, payload);
    if (afterLock) return this.replay(session, afterLock, key, hash);
    if (wallet.playerId !== tx.playerId)
      throw new InvalidBetError('PLAYER_MISMATCH');
    if (wallet.currency !== tx.money.currency)
      throw new InvalidBetError('CURRENCY_MISMATCH');
    await session.wagers.create(tx);
    // Os tipos compartilham a idempotência; LOSS registra somente o resultado da rodada.
    let processor:
      ProcessBet | ProcessWin | ProcessLoss | ProcessRefund | ProcessRollback;
    switch (tx.kind) {
      case WagerTransactionKind.Bet:
        processor = new ProcessBet(this.unitOfWork);
        break;
      case WagerTransactionKind.Win:
        processor = new ProcessWin(this.unitOfWork);
        break;
      case WagerTransactionKind.Loss:
        processor = new ProcessLoss(this.unitOfWork);
        break;
      case WagerTransactionKind.Refund:
        processor = new ProcessRefund(this.unitOfWork);
        break;
      case WagerTransactionKind.Rollback:
        processor = new ProcessRollback(this.unitOfWork);
        break;
      default:
        throw new InvalidBetError('INVALID_TRANSACTION_KIND');
    }
    const result = await processor.executeInTransaction(session, tx.id);
    return { ...result, idempotentReplay: false };
  }

  private async existing(
    session: RepositorySession,
    key: string,
    input: SubmitWagerInput,
  ) {
    return (
      (await session.wagers.findByIdempotencyKey(key)) ??
      (await session.wagers.findByExternalId(
        input.providerId,
        input.externalTransactionId,
      ))
    );
  }
  private async replay(
    session: RepositorySession,
    tx: WagerTransaction,
    key: string,
    hash: string,
  ): Promise<SubmitWagerResult> {
    // Um external ID com outra chave é conflito: o header é a fonte de verdade.
    if (tx.idempotencyKey !== key) throw new IdempotencyConflictError();
    tx.assertMatchesPayload(hash);
    if (
      tx.status !== WagerTransactionStatus.Processed &&
      tx.status !== WagerTransactionStatus.Rejected &&
      tx.status !== WagerTransactionStatus.PendingReference
    )
      throw new StoredResultUnavailableError();
    const balance = await session.wagers.findObservedBalance(tx.id);
    if (!balance) throw new StoredResultUnavailableError();
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: balance.toJSON(),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      idempotentReplay: true,
    };
  }
  private isIdentityRace(error: unknown): boolean {
    return (
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      [
        'wager_transactions_idempotency_key_key',
        'wager_transactions_provider_id_external_transaction_id_key',
      ].includes(String(error.constraint))
    );
  }
}
