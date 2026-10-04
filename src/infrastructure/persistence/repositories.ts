import { LockMode } from '@mikro-orm/core';
import { WalletAlreadyExistsError } from '../../application/errors.js';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money, CurrencyMismatchError } from '../../domain/money.js';
import type { Wallet } from '../../domain/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import type {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionKind,
} from '../../domain/wager-transaction.js';
import {
  InvalidLedgerPageError,
  PersistenceConflictError,
  TransactionRequiredError,
  type WalletRepository,
  type WagerRepository,
  type LedgerRepository,
  type LedgerPage,
  type LedgerPageOptions,
} from '../../application/ports/repositories.js';
import {
  WalletEntity,
  WagerTransactionEntity,
  LedgerEntryEntity,
  type LedgerEntryRecord,
} from './entities.js';
import {
  walletFromRecord,
  walletToRecord,
  transactionFromRecord,
  transactionToRecord,
  ledgerFromRecord,
  ledgerToRecord,
} from './mappers.js';

// Todos os repositories da sessão recebem o MESMO EntityManager, sem abrir outro commit.
function requireTransaction(em: EntityManager): void {
  if (!em.isInTransaction()) throw new TransactionRequiredError();
}

export class PostgreSqlWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    // refresh evita devolver um registro antigo do Identity Map após um UPDATE nativo.
    const row = await this.em.findOne(WalletEntity, { id }, { refresh: true });
    return row ? walletFromRecord(row) : undefined;
  }
  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    requireTransaction(this.em);
    // SELECT FOR UPDATE bloqueia somente a wallet escolhida até terminar a transação.
    const row = await this.em.findOne(
      WalletEntity,
      { id },
      { refresh: true, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row ? walletFromRecord(row) : undefined;
  }
  async exists(playerId: string, currency: string): Promise<boolean> {
    return (await this.em.count(WalletEntity, { playerId, currency })) > 0;
  }
  async create(wallet: Wallet): Promise<void> {
    requireTransaction(this.em);
    // INSERT imediato respeita a ordem wallet → transação → ledger no mesmo commit.
    try {
      await this.em.insert(WalletEntity, walletToRecord(wallet));
    } catch (error) {
      // O EXISTS anterior não impede uma corrida, a constraint resolve a disputa final.
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505' &&
        'constraint' in error &&
        error.constraint === 'wallets_player_id_currency_key'
      ) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }
  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    requireTransaction(this.em);
    // A versão lida faz parte do WHERE: uma cópia antiga nunca sobrescreve saldo novo.
    const affected = await this.em.nativeUpdate(
      WalletEntity,
      { id: wallet.id, version: expectedVersion },
      {
        balance: wallet.balance.toString(),
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (affected !== 1) throw new PersistenceConflictError();
  }
}

export class PostgreSqlWagerRepository implements WagerRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      WagerTransactionEntity,
      { id },
      { refresh: true },
    );
    return row ? transactionFromRecord(row) : undefined;
  }
  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      WagerTransactionEntity,
      { providerId, externalTransactionId },
      { refresh: true },
    );
    return row ? transactionFromRecord(row) : undefined;
  }
  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      WagerTransactionEntity,
      { idempotencyKey },
      { refresh: true },
    );
    return row ? transactionFromRecord(row) : undefined;
  }
  async create(tx: WagerTransaction, observedBalance?: Money): Promise<void> {
    requireTransaction(this.em);
    this.assertBalanceCurrency(tx, observedBalance);
    await this.em.insert(WagerTransactionEntity, {
      ...transactionToRecord(tx, tx.createdAt),
      observedBalance: observedBalance?.toString(),
    });
  }
  async findObservedBalance(id: string): Promise<Money | undefined> {
    const row = await this.em.findOne(
      WagerTransactionEntity,
      { id },
      { refresh: true },
    );
    return row?.observedBalance != null
      ? Money.from({ amount: row.observedBalance, currency: row.currency })
      : undefined;
  }
  async hasProcessedReversal(
    referenceId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    return (
      (await this.em.count(WagerTransactionEntity, {
        referenceTransactionId: referenceId,
        kind,
        status: 'PROCESSED',
      })) > 0
    );
  }
  async updateState(
    tx: WagerTransaction,
    expectedStatus: WagerTransactionStatus,
    at: Date,
    observedBalance?: Money,
  ): Promise<void> {
    requireTransaction(this.em);
    this.assertBalanceCurrency(tx, observedBalance);
    // Só atualiza o estado; identidade, payload e valor financeiro ficam intocados.
    const affected = await this.em.nativeUpdate(
      WagerTransactionEntity,
      { id: tx.id, status: expectedStatus },
      {
        status: tx.status,
        referenceTransactionId: tx.referenceTransactionId ?? null,
        failureCode: tx.failureCode ?? null,
        processedAt: tx.processedAt ?? null,
        updatedAt: at,
        ...(observedBalance
          ? { observedBalance: observedBalance.toString() }
          : {}),
      },
    );
    if (affected !== 1) throw new PersistenceConflictError();
  }
  private assertBalanceCurrency(tx: WagerTransaction, balance?: Money): void {
    if (balance && tx.money.currency !== balance.currency)
      throw new CurrencyMismatchError(tx.money.currency, balance.currency);
    if (balance?.isNegative())
      throw new Error('Observed wallet balance cannot be negative');
  }
}

interface LedgerCursor {
  version: 1;
  walletId: string;
  at: string;
  id: string;
}
interface LedgerCursorRecord extends Omit<LedgerEntryRecord, 'createdAt'> {
  createdAt: string;
  cursorTimestamp: string;
}
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class PostgreSqlLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  // O repository do ledger oferece somente INSERT e consultas, nunca UPDATE ou DELETE.
  async create(entry: WalletLedgerEntry): Promise<void> {
    requireTransaction(this.em);
    await this.em.insert(LedgerEntryEntity, ledgerToRecord(entry));
  }
  async findByTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | undefined> {
    const row = await this.em.findOne(LedgerEntryEntity, {
      walletId,
      transactionId,
    });
    return row ? ledgerFromRecord(row) : undefined;
  }
  async findByWallet(
    walletId: string,
    options: LedgerPageOptions = {},
  ): Promise<LedgerPage> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new InvalidLedgerPageError();
    const cursor =
      options.cursor === undefined
        ? undefined
        : this.decodeCursor(options.cursor, walletId);
    // A ordenação por data + ID desempata datas iguais. Não usamos OFFSET.
    // O cursor mantém microssegundos do PostgreSQL, que Date do JS não representa.
    const rows = await this.em.execute<LedgerCursorRecord[]>(
      `
      SELECT id, wallet_id AS "walletId", transaction_id AS "transactionId", direction,
        amount, currency, balance_before AS "balanceBefore", balance_after AS "balanceAfter",
        created_at AS "createdAt",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTimestamp"
      FROM wallet_ledger_entries WHERE wallet_id = ?
        ${cursor ? 'AND (created_at, id) > (?::timestamptz, ?::uuid)' : ''}
      ORDER BY created_at ASC, id ASC LIMIT ?`,
      cursor
        ? [walletId, cursor.at, cursor.id, limit + 1]
        : [walletId, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      // execute retorna timestamps como strings; normalizamos a data antes da reidratação.
      entries: page.map((row) =>
        ledgerFromRecord({ ...row, createdAt: new Date(row.createdAt) }),
      ),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                walletId,
                at: last.cursorTimestamp,
                id: last.id,
              } satisfies LedgerCursor),
            ).toString('base64url')
          : undefined,
    };
  }
  private decodeCursor(encoded: string, walletId: string): LedgerCursor {
    try {
      if (encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded))
        throw new InvalidLedgerPageError();
      const decoded: unknown = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      );
      if (!decoded || typeof decoded !== 'object')
        throw new InvalidLedgerPageError();
      const cursor = decoded as Partial<LedgerCursor>;
      if (
        cursor.version !== 1 ||
        cursor.walletId !== walletId ||
        typeof cursor.id !== 'string' ||
        !uuidPattern.test(cursor.id) ||
        typeof cursor.at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at) ||
        !Number.isFinite(Date.parse(cursor.at)) ||
        new Date(cursor.at).toISOString().slice(0, 19) !==
          cursor.at.slice(0, 19)
      )
        throw new InvalidLedgerPageError();
      return cursor as LedgerCursor;
    } catch {
      throw new InvalidLedgerPageError();
    }
  }
}
