import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from '../../src/application/create-wallet.js';
import {
  InvalidBetError,
  ProcessBet,
} from '../../src/application/process-bet.js';
import type {
  RepositorySession,
  UnitOfWork,
} from '../../src/application/ports/repositories.js';
import { Money } from '../../src/domain/money.js';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry.js';
import {
  FailureCode,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';

const connect = () => MikroORM.init(createOrmConfig('dwp_test'));
let orm: Awaited<ReturnType<typeof connect>>;
let uow: PostgreSqlUnitOfWork;
let processor: ProcessBet;

// Aguarda a rejeição de verdade antes de conferir o erro; sucesso inesperado faz o teste falhar.
async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}

// Prepara uma wallet pela aplicação real e uma transação pendente como a futura entrada fará.
async function seed(balance = '100.00', amount = '25.00', kind = Kind.Bet) {
  const wallet = await new CreateWallet(uow).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  const id = crypto.randomUUID();
  const props = {
    id,
    providerId: 'provider-bet-tests',
    externalTransactionId: id,
    idempotencyKey: `bet:${id}`,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: Money.from({ amount, currency: 'BRL' }),
    createdAt: new Date(),
  };
  const tx = WagerTransaction.create(props);
  await uow.transaction(({ wagers }) => wagers.create(tx));
  return { wallet, tx, props };
}

// Inspeciona o saldo, o resultado auditável e SOMENTE o ledger da BET (exclui a abertura).
async function snapshot(id: string) {
  const rows = await orm.em.fork().execute(
    `SELECT w.balance, w.version, t.status, t.failure_code, t.observed_balance,
    (SELECT count(*) FROM wallet_ledger_entries WHERE transaction_id = t.id) AS entries
    FROM wager_transactions t JOIN wallets w ON w.id = t.wallet_id WHERE t.id = ?`,
    [id],
  );
  return rows[0];
}

// Mantém os repositories reais, substituindo apenas o ponto em que queremos simular uma falha.
function withSession(
  change: (session: RepositorySession) => RepositorySession,
): UnitOfWork {
  return {
    read: (operation) => uow.read(operation),
    transaction: (operation) =>
      uow.transaction((session) => operation(change(session))),
  };
}

describe('ProcessBet with PostgreSQL', () => {
  beforeAll(async () => {
    orm = await connect();
    await orm.migrator.up();
    uow = new PostgreSqlUnitOfWork(orm);
    processor = new ProcessBet(uow);
  });
  afterAll(async () => {
    if (orm) await orm.close();
  });

  it('debits exactly, records the before/after balances and increments version once', async () => {
    const { tx } = await seed();
    expect(await processor.execute(tx.id)).toEqual({
      transactionId: tx.id,
      status: Status.Processed,
      balance: { amount: '75.00', currency: 'BRL' },
    });
    expect(await snapshot(tx.id)).toMatchObject({
      balance: '75.00',
      version: 2,
      status: 'PROCESSED',
      failure_code: null,
      observed_balance: '75.00',
      entries: '1',
    });
    const entry = await uow.read(({ ledger }) =>
      ledger.findByTransaction(tx.walletId, tx.id),
    );
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(entry?.money.toString()).toBe('25.00');
    expect(entry?.balanceBefore.toString()).toBe('100.00');
    expect(entry?.balanceAfter.toString()).toBe('75.00');
  });

  // O limite é inclusivo: gastar exatamente o saldo é permitido, deixá-lo negativo não é.
  it('allows a bet equal to the entire available balance', async () => {
    const { tx } = await seed('25.00', '25.00');
    await processor.execute(tx.id);
    expect(await snapshot(tx.id)).toMatchObject({
      balance: '0.00',
      version: 2,
      entries: '1',
    });
  });

  it.each(['100.01', '999999999999999999.99'])(
    'rejects insufficient balance %s without a debit',
    async (amount) => {
      const { tx } = await seed('100.00', amount);
      const before = await uow.read(({ wallets }) =>
        wallets.findById(tx.walletId),
      );
      expect(await processor.execute(tx.id)).toEqual({
        transactionId: tx.id,
        status: Status.Rejected,
        balance: { amount: '100.00', currency: 'BRL' },
        failureCode: FailureCode.InsufficientBalance,
      });
      expect(await snapshot(tx.id)).toMatchObject({
        balance: '100.00',
        version: 1,
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_BALANCE',
        observed_balance: '100.00',
        entries: '0',
      });
      const after = await uow.read(({ wallets }) =>
        wallets.findById(tx.walletId),
      );
      expect(after?.updatedAt).toEqual(before?.updatedAt);
    },
  );

  it('accepts zero as a processed operation without changing balance, version or ledger', async () => {
    const { tx } = await seed('100.00', '0.00');
    await processor.execute(tx.id);
    expect(await snapshot(tx.id)).toMatchObject({
      balance: '100.00',
      version: 1,
      status: 'PROCESSED',
      entries: '0',
    });
  });

  it('preserves cents above the JavaScript safe integer range', async () => {
    const { tx } = await seed('999999999999999999.99', '0.01');
    await processor.execute(tx.id);
    expect((await snapshot(tx.id)).balance).toBe('999999999999999999.98');
  });

  it('does not process another operation kind', async () => {
    const { tx } = await seed('100.00', '25.00', Kind.Win);
    expect(await rejection(processor.execute(tx.id))).toBeInstanceOf(
      InvalidBetError,
    );
    expect(await snapshot(tx.id)).toMatchObject({
      balance: '100.00',
      status: 'PENDING',
      entries: '0',
    });
  });

  it('reports an absent transaction without creating records', async () => {
    expect(
      await rejection(processor.execute(crypto.randomUUID())),
    ).toMatchObject({
      reason: 'TRANSACTION_NOT_FOUND',
    });
  });

  // As FKs impedem esses dados no PostgreSQL; simulamos leitura incompatível para testar a defesa da aplicação.
  it.each(['wallet', 'player', 'currency', 'missing-wallet'])(
    'validates %s before changing persisted state',
    async (scenario) => {
      const { tx, props } = await seed();
      const invalid = WagerTransaction.create({
        ...props,
        ...(scenario === 'wallet' ? { walletId: crypto.randomUUID() } : {}),
        ...(scenario === 'player' ? { playerId: crypto.randomUUID() } : {}),
        ...(scenario === 'currency'
          ? { money: Money.from({ amount: '25.00', currency: 'USD' }) }
          : {}),
      });
      let reads = 0;
      const guarded = new ProcessBet(
        withSession((session) => ({
          ...session,
          wallets: {
            findById: session.wallets.findById.bind(session.wallets),
            findByIdForUpdate:
              scenario === 'missing-wallet'
                ? async () => undefined
                : session.wallets.findByIdForUpdate.bind(session.wallets),
            findByIdForUpdateSkipLocked:
              session.wallets.findByIdForUpdateSkipLocked.bind(session.wallets),
            exists: session.wallets.exists.bind(session.wallets),
            create: session.wallets.create.bind(session.wallets),
            save: session.wallets.save.bind(session.wallets),
          },
          wagers: {
            findById: async () => (++reads === 1 ? tx : invalid),
            findByExternalId: session.wagers.findByExternalId.bind(
              session.wagers,
            ),
            findByIdempotencyKey: session.wagers.findByIdempotencyKey.bind(
              session.wagers,
            ),
            findObservedBalance: session.wagers.findObservedBalance.bind(
              session.wagers,
            ),
            hasProcessedReversal: session.wagers.hasProcessedReversal.bind(
              session.wagers,
            ),
            create: session.wagers.create.bind(session.wagers),
            updateState: session.wagers.updateState.bind(session.wagers),
          },
        })),
      );
      const reason = {
        wallet: 'WALLET_MISMATCH',
        player: 'PLAYER_MISMATCH',
        currency: 'CURRENCY_MISMATCH',
        'missing-wallet': 'WALLET_NOT_FOUND',
      }[scenario];
      expect(await rejection(guarded.execute(tx.id))).toMatchObject({ reason });
      expect(await snapshot(tx.id)).toMatchObject({
        balance: '100.00',
        version: 1,
        status: 'PENDING',
        entries: '0',
      });
    },
  );

  // Falha após salvar o débito deve desfazê-lo; falha no estado deve desfazer também o ledger.
  it.each(['ledger', 'state'])(
    'rolls back every financial write when %s fails, then allows retry',
    async (point) => {
      const { tx } = await seed();
      const fail = async (): Promise<never> => {
        throw new Error('Injected persistence failure');
      };
      const broken = new ProcessBet(
        withSession((session) => ({
          ...session,
          ledger: {
            create:
              point === 'ledger'
                ? fail
                : session.ledger.create.bind(session.ledger),
            findByTransaction: session.ledger.findByTransaction.bind(
              session.ledger,
            ),
            findByWallet: session.ledger.findByWallet.bind(session.ledger),
          },
          wagers: {
            findById: session.wagers.findById.bind(session.wagers),
            findByExternalId: session.wagers.findByExternalId.bind(
              session.wagers,
            ),
            findByIdempotencyKey: session.wagers.findByIdempotencyKey.bind(
              session.wagers,
            ),
            findObservedBalance: session.wagers.findObservedBalance.bind(
              session.wagers,
            ),
            hasProcessedReversal: session.wagers.hasProcessedReversal.bind(
              session.wagers,
            ),
            create: session.wagers.create.bind(session.wagers),
            updateState:
              point === 'state'
                ? fail
                : session.wagers.updateState.bind(session.wagers),
          },
        })),
      );
      expect(await rejection(broken.execute(tx.id))).toMatchObject({
        message: 'Injected persistence failure',
      });
      expect(await snapshot(tx.id)).toMatchObject({
        balance: '100.00',
        version: 1,
        status: 'PENDING',
        observed_balance: null,
        entries: '0',
      });
      await processor.execute(tx.id);
      expect(await snapshot(tx.id)).toMatchObject({
        balance: '75.00',
        version: 2,
        entries: '1',
      });
    },
  );

  it.each(['25.00', '100.01'])(
    'does not debit or transition a terminal transaction again (%s)',
    async (amount) => {
      const { tx } = await seed('100.00', amount);
      await processor.execute(tx.id);
      const before = await snapshot(tx.id);
      expect(await rejection(processor.execute(tx.id))).toBeInstanceOf(
        InvalidTransactionStateError,
      );
      expect(await snapshot(tx.id)).toEqual(before);
    },
  );

  // Duas execuções do mesmo ID podem ler PENDING; a releitura após o lock evita o segundo débito.
  it('guards the same pending transaction against simultaneous executions', async () => {
    const { tx } = await seed();
    const results = await Promise.allSettled([
      processor.execute(tx.id),
      processor.execute(tx.id),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
      InvalidTransactionStateError,
    );
    expect(await snapshot(tx.id)).toMatchObject({
      balance: '75.00',
      version: 2,
      entries: '1',
    });
  });
});
