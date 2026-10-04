import type { Money } from '../../domain/money.js';
import type { TelemetryEvent } from './telemetry.js';
import type { InboxMessage } from '../../domain/inbox-message.js';
import type { OutboxMessage } from '../../domain/outbox-message.js';
import type { Wallet } from '../../domain/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import type {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionKind,
} from '../../domain/wager-transaction.js';

// Portas são contratos da aplicação; não importam NestJS, MikroORM ou PostgreSQL.
export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  // Worker não espera por wallet ocupada: libera o lote para tentar outras wallets.
  findByIdForUpdateSkipLocked(id: string): Promise<Wallet | undefined>;
  exists(playerId: string, currency: string): Promise<boolean>;
  create(wallet: Wallet): Promise<void>;
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}
export interface WagerRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  // Saldo observado pertence ao resultado original, não ao saldo atual da wallet.
  findObservedBalance(id: string): Promise<Money | undefined>;
  // Consulta a reversão finalizada; tentativas pendentes/rejeitadas não consomem a referência.
  hasProcessedReversal(
    referenceId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean>;
  create(tx: WagerTransaction, observedBalance?: Money): Promise<void>;
  updateState(
    tx: WagerTransaction,
    expectedStatus: WagerTransactionStatus,
    at: Date,
    observedBalance?: Money,
  ): Promise<void>;
}
export interface LedgerPageOptions {
  cursor?: string;
  limit?: number;
}
export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}
export interface LedgerRepository {
  create(entry: WalletLedgerEntry): Promise<void>;
  findByTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | undefined>;
  findByWallet(
    walletId: string,
    options?: LedgerPageOptions,
  ): Promise<LedgerPage>;
}
export interface RepositorySession {
  // Publica observações somente depois do commit, descartando-as no rollback.
  recordAfterCommit?: (event: TelemetryEvent) => void;
  wallets: WalletRepository;
  wagers: WagerRepository;
  ledger: LedgerRepository;
  pendingReferences: PendingReferenceRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}
export interface OutboxRepository {
  create(message: OutboxMessage): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;
  // Seleciona um evento confirmado e devido; SKIP LOCKED permite publishers independentes.
  lockNextDue(now: Date): Promise<OutboxMessage | undefined>;
  save(message: OutboxMessage, expectedAttempts: number): Promise<void>;
}

export interface InboxRepository {
  find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined>;
  // Exige transação; retorna a mensagem nova ou a existente sob lock exclusivo.
  receive(message: InboxMessage): Promise<InboxMessage>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface PendingReferenceSchedule {
  attempts: number;
  nextAttemptAt: Date;
}
export interface PendingReferenceRepository {
  findDue(now: Date, limit: number): Promise<string[]>;
  findSchedule(
    transactionId: string,
  ): Promise<PendingReferenceSchedule | undefined>;
  reschedule(
    transactionId: string,
    attempts: number,
    nextAttemptAt: Date,
  ): Promise<void>;
}

// Um único contexto reúne as gravações para confirmar tudo junto ou desfazer tudo.
export interface UnitOfWork {
  read<T>(operation: (session: RepositorySession) => Promise<T>): Promise<T>;
  transaction<T>(
    operation: (session: RepositorySession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export class PersistenceConflictError extends Error {
  constructor() {
    super('Persisted state changed or record does not exist');
    this.name = 'PersistenceConflictError';
  }
}
export class TransactionRequiredError extends Error {
  constructor() {
    super('Writes and wallet locks require an active transaction');
    this.name = 'TransactionRequiredError';
  }
}
export class InvalidLedgerPageError extends Error {
  constructor() {
    super('Invalid ledger cursor or limit');
    this.name = 'InvalidLedgerPageError';
  }
}
