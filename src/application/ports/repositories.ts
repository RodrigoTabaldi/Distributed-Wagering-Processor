import type { Money } from '../../domain/money.js';
import type { Wallet } from '../../domain/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import type {
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';

// Portas são contratos da aplicação; não importam NestJS, MikroORM ou PostgreSQL.
export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
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
  wallets: WalletRepository;
  wagers: WagerRepository;
  ledger: LedgerRepository;
}

// Um único contexto reúne as gravações para confirmar tudo junto ou desfazer tudo.
export interface UnitOfWork {
  read<T>(operation: (session: RepositorySession) => Promise<T>): Promise<T>;
  transaction<T>(
    operation: (session: RepositorySession) => Promise<T>,
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
