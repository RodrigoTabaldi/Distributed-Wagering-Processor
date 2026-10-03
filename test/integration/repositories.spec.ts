import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money.js';
import { Wallet } from '../../src/domain/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/domain/wager-transaction.js';
import {
  InvalidLedgerPageError,
  PersistenceConflictError,
  TransactionRequiredError,
} from '../../src/application/ports/repositories.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { PostgreSqlWalletRepository } from '../../src/infrastructure/persistence/repositories.js';
import { WagerTransactionEntity } from '../../src/infrastructure/persistence/entities.js';
import { transactionToRecord } from '../../src/infrastructure/persistence/mappers.js';

const connect = () => MikroORM.init(createOrmConfig('dwp_test'));
let orm: Awaited<ReturnType<typeof connect>>;
let uow: PostgreSqlUnitOfWork;
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-03T12:00:00.000Z');

function operation(wallet: Wallet, kind = Kind.Bet) {
  const id = crypto.randomUUID();
  return WagerTransaction.create({
    id,
    providerId: 'provider',
    externalTransactionId: id,
    idempotencyKey: `provider:${id}`,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: brl('10.00'),
    createdAt: at,
  });
}
async function seed() {
  const id = crypto.randomUUID();
  const opening = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: brl('100.00'),
    at,
    opening: { entryId: crypto.randomUUID(), transactionId: id },
  });
  const tx = WagerTransaction.createOpening({
    id,
    providerId: 'internal',
    externalTransactionId: id,
    idempotencyKey: `opening:${id}`,
    payloadHash: 'a'.repeat(64),
    walletId: opening.wallet.id,
    playerId: opening.wallet.playerId,
    roundId: 'opening',
    gameId: 'opening',
    money: brl('100.00'),
    createdAt: at,
  });
  tx.markProcessed(undefined, at);
  await uow.transaction(async ({ wallets, wagers, ledger }) => {
    await wallets.create(opening.wallet);
    await wagers.create(tx, opening.wallet.balance);
    await ledger.create(opening.openingEntry!);
  });
  return { ...opening, tx };
}
async function bet(walletId: string, expectedVersion?: number) {
  return uow.transaction(async ({ wallets, wagers, ledger }) => {
    const wallet = await wallets.findByIdForUpdate(walletId);
    if (!wallet) throw new Error('Expected wallet');
    const version = wallet.version;
    const tx = operation(wallet);
    await wagers.create(tx);
    const entry = wallet.debit({
      entryId: crypto.randomUUID(),
      transactionId: tx.id,
      money: tx.money,
      at,
    });
    tx.markProcessed(undefined, at);
    await wallets.save(wallet, expectedVersion ?? version);
    await wagers.updateState(tx, Status.Pending, at, wallet.balance);
    await ledger.create(entry!);
    return tx;
  });
}

// Verifica a implementação usando PostgreSQL real, incluindo sessões independentes.
describe('Repositories', () => {
  beforeAll(async () => {
    orm = await connect();
    await orm.migrator.up();
    uow = new PostgreSqlUnitOfWork(orm);
  });
  afterAll(async () => {
    if (orm) await orm.close();
  });

  it('creates and queries wallet, wager and ledger as domain objects', async () => {
    const { wallet, tx, openingEntry } = await seed();
    await uow.read(async ({ wallets, wagers, ledger }) => {
      expect((await wallets.findById(wallet.id))?.balance.toString()).toBe(
        '100.00',
      );
      expect(await wallets.exists(wallet.playerId, 'BRL')).toBe(true);
      expect(await wallets.exists(wallet.playerId, 'USD')).toBe(false);
      expect((await wagers.findById(tx.id))?.status).toBe(Status.Processed);
      expect(
        (await wagers.findByExternalId('internal', tx.externalTransactionId))
          ?.id,
      ).toBe(tx.id);
      expect(
        await wagers.findByExternalId(
          'different-provider',
          tx.externalTransactionId,
        ),
      ).toBeUndefined();
      expect((await wagers.findByIdempotencyKey(tx.idempotencyKey))?.id).toBe(
        tx.id,
      );
      expect((await ledger.findByTransaction(wallet.id, tx.id))?.id).toBe(
        openingEntry?.id,
      );
    });
  });

  it('returns undefined for absent records', async () => {
    await uow.read(async ({ wallets, wagers, ledger }) => {
      const id = crypto.randomUUID();
      expect(await wallets.findById(id)).toBeUndefined();
      expect(await wagers.findById(id)).toBeUndefined();
      expect(await wagers.findByIdempotencyKey(id)).toBeUndefined();
      expect(await ledger.findByTransaction(id, id)).toBeUndefined();
      expect((await ledger.findByWallet(id)).entries).toEqual([]);
    });
  });

  // Exigir transação evita confirmar saldo antes do ledger por acidente.
  it('rejects writes and locks outside a transaction', async () => {
    const { wallet, tx, openingEntry } = await seed();
    await uow.read(async ({ wallets, wagers, ledger }) => {
      for (const action of [
        () => wallets.create(wallet),
        () => wallets.save(wallet, 1),
        () => wallets.findByIdForUpdate(wallet.id),
        () => wagers.create(tx),
        () => wagers.updateState(tx, Status.Pending, at),
        () => ledger.create(openingEntry!),
      ]) {
        try {
          await action();
          throw new Error('Expected transaction guard');
        } catch (error) {
          expect(error).toBeInstanceOf(TransactionRequiredError);
        }
      }
    });
  });

  it('saves a movement and transaction state in one commit', async () => {
    const { wallet } = await seed();
    const tx = await bet(wallet.id);
    await uow.read(async ({ wallets, wagers, ledger }) => {
      expect((await wallets.findById(wallet.id))?.balance.toString()).toBe(
        '90.00',
      );
      expect((await wallets.findById(wallet.id))?.version).toBe(2);
      expect((await wagers.findById(tx.id))?.status).toBe(Status.Processed);
      expect(
        (
          await ledger.findByTransaction(wallet.id, tx.id)
        )?.balanceAfter.toString(),
      ).toBe('90.00');
    });
    const row = await orm.em
      .fork()
      .execute('SELECT observed_balance FROM wager_transactions WHERE id = ?', [
        tx.id,
      ]);
    expect(row[0].observed_balance).toBe('90.00');
  });

  it('reads fresh state after native updates in the same session', async () => {
    const { wallet } = await seed();
    await uow.transaction(async ({ wagers }) => {
      const tx = operation(wallet, Kind.Loss);
      await wagers.create(tx);
      expect((await wagers.findById(tx.id))?.status).toBe(Status.Pending);
      tx.markProcessed(undefined, at);
      await wagers.updateState(tx, Status.Pending, at, wallet.balance);
      expect((await wagers.findById(tx.id))?.status).toBe(Status.Processed);
    });
  });

  // Estado de rejeição deve ser auditável, sem nenhum lançamento financeiro novo.
  it('updates a rejected transaction without creating ledger', async () => {
    const { wallet } = await seed();
    const tx = operation(wallet);
    await uow.transaction(async ({ wagers }) => {
      await wagers.create(tx);
      tx.reject(FailureCode.InsufficientBalance);
      await wagers.updateState(tx, Status.Pending, at, wallet.balance);
    });
    await uow.read(async ({ wagers, ledger }) => {
      expect((await wagers.findById(tx.id))?.failureCode).toBe(
        FailureCode.InsufficientBalance,
      );
      expect(await ledger.findByTransaction(wallet.id, tx.id)).toBeUndefined();
    });
  });

  it('rejects a stale wallet version and rolls back the attempted transaction', async () => {
    const { wallet } = await seed();
    await bet(wallet.id);
    let error: unknown;
    try {
      await bet(wallet.id, 1);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PersistenceConflictError);
    await uow.read(async ({ wallets, ledger }) => {
      expect((await wallets.findById(wallet.id))?.balance.toString()).toBe(
        '90.00',
      );
      expect((await ledger.findByWallet(wallet.id)).entries.length).toBe(2);
    });
  });

  it('rolls back wallet creation when the callback fails', async () => {
    const { wallet } = Wallet.open({
      id: crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      initialBalance: brl('0.00'),
      at,
    });
    try {
      await uow.transaction(async ({ wallets }) => {
        await wallets.create(wallet);
        throw new Error('Injected failure');
      });
    } catch (error) {
      expect((error as Error).message).toBe('Injected failure');
    }
    expect(
      await uow.read(({ wallets }) => wallets.findById(wallet.id)),
    ).toBeUndefined();
  });

  it('rejects a stale transaction status without replacing its saved result', async () => {
    const { wallet } = await seed();
    const tx = operation(wallet);
    await uow.transaction(async ({ wagers }) => {
      await wagers.create(tx);
      tx.reject(FailureCode.InsufficientBalance);
      await wagers.updateState(tx, Status.Pending, at, wallet.balance);
    });
    let error: unknown;
    try {
      await uow.transaction(({ wagers }) =>
        wagers.updateState(tx, Status.Pending, at),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PersistenceConflictError);
    expect(
      (await uow.read(({ wagers }) => wagers.findById(tx.id)))?.failureCode,
    ).toBe(FailureCode.InsufficientBalance);
  });

  // A callback pode terminar, mas o commit ainda pode falhar nas constraints diferidas.
  it('propagates commit failures and restores the persisted wallet balance', async () => {
    const { wallet } = await seed();
    let error: unknown;
    try {
      await uow.transaction(async ({ wallets }) => {
        const current = (await wallets.findByIdForUpdate(wallet.id))!;
        current.debit({
          entryId: crypto.randomUUID(),
          transactionId: crypto.randomUUID(),
          money: brl('10.00'),
          at,
        });
        await wallets.save(current, 1); // Omite o ledger de propósito para testar o commit.
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: '23514' });
    expect(
      (
        await uow.read(({ wallets }) => wallets.findById(wallet.id))
      )?.balance.toString(),
    ).toBe('100.00');
  });

  it.each([
    '',
    'not-json',
    '!',
    'a'.repeat(513),
    Buffer.from('null').toString('base64url'),
  ])('rejects malformed ledger cursors', async (cursor) => {
    let error: unknown;
    try {
      await uow.read(({ ledger }) =>
        ledger.findByWallet(crypto.randomUUID(), { cursor }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidLedgerPageError);
  });

  it('rejects impossible cursor dates and unsupported cursor versions', async () => {
    const walletId = crypto.randomUUID();
    for (const data of [
      {
        version: 1,
        walletId,
        id: crypto.randomUUID(),
        at: '2026-02-31T12:00:00.000000Z',
      },
      {
        version: 2,
        walletId,
        id: crypto.randomUUID(),
        at: '2026-02-01T12:00:00.000000Z',
      },
    ]) {
      let error: unknown;
      try {
        await uow.read(({ ledger }) =>
          ledger.findByWallet(walletId, {
            cursor: Buffer.from(JSON.stringify(data)).toString('base64url'),
          }),
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(InvalidLedgerPageError);
    }
  });

  // Datas iguais são desempatas pelo ID. O cursor fica vinculado à wallet consultada.
  it('paginates equal timestamps without duplicates or omissions', async () => {
    const { wallet } = await seed();
    await bet(wallet.id);
    await bet(wallet.id);
    await bet(wallet.id);
    const all = await uow.read(({ ledger }) => ledger.findByWallet(wallet.id));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await uow.read(({ ledger }) =>
        ledger.findByWallet(wallet.id, { limit: 2, cursor }),
      );
      ids.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toEqual(all.entries.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(4);
    const first = await uow.read(({ ledger }) =>
      ledger.findByWallet(wallet.id, { limit: 1 }),
    );
    const other = await seed();
    try {
      await uow.read(({ ledger }) =>
        ledger.findByWallet(other.wallet.id, { cursor: first.nextCursor }),
      );
      throw new Error('Expected invalid cursor');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidLedgerPageError);
    }
  });

  it('preserves PostgreSQL microseconds in pagination cursors', async () => {
    const { wallet } = await seed();
    for (const fraction of ['000001', '000002', '000003']) {
      await orm.em.fork().transactional(async (em) => {
        const tx = operation(wallet, Kind.Win);
        tx.markProcessed(undefined, at);
        await em.insert(WagerTransactionEntity, transactionToRecord(tx, at));
        const originalVersion = wallet.version;
        const entry = wallet.credit({
          entryId: crypto.randomUUID(),
          transactionId: tx.id,
          money: tx.money,
          at,
        });
        // INSERT SQL cria a data com microssegundos; não altera um ledger existente.
        await em.execute(
          `INSERT INTO wallet_ledger_entries VALUES (?, ?, ?, 'CREDIT', ?, 'BRL', ?, ?, ?::timestamptz)`,
          [
            entry!.id,
            wallet.id,
            tx.id,
            tx.money.toString(),
            entry!.balanceBefore.toString(),
            entry!.balanceAfter.toString(),
            `2026-10-03T12:00:00.${fraction}Z`,
          ],
        );
        await new PostgreSqlWalletRepository(em).save(wallet, originalVersion);
      });
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await uow.read(({ ledger }) =>
        ledger.findByWallet(wallet.id, { limit: 1, cursor }),
      );
      ids.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);
  });

  it.each([0, -1, 101, 1.5])('rejects invalid page limit %s', async (limit) => {
    try {
      await uow.read(({ ledger }) =>
        ledger.findByWallet(crypto.randomUUID(), { limit }),
      );
      throw new Error('Expected invalid limit');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidLedgerPageError);
    }
  });

  // Mantém um lock numa sessão e usa lock_timeout em outra: prova disputa real no banco.
  it('locks one wallet while allowing a different wallet to proceed', async () => {
    const first = await seed();
    const second = await seed();
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const owner = uow.transaction(async ({ wallets }) => {
      await wallets.findByIdForUpdate(first.wallet.id);
      acquired.resolve();
      await release.promise;
    });
    try {
      await acquired.promise;
      await uow.transaction(async ({ wallets }) => {
        expect((await wallets.findByIdForUpdate(second.wallet.id))?.id).toBe(
          second.wallet.id,
        );
      });
      let error: unknown;
      try {
        await orm.em.fork().transactional(async (em) => {
          await em.execute("SET LOCAL lock_timeout = '100ms'");
          await new PostgreSqlWalletRepository(em).findByIdForUpdate(
            first.wallet.id,
          );
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: '55P03' });
    } finally {
      release.resolve();
      await owner;
    }
    await uow.transaction(async ({ wallets }) => {
      expect((await wallets.findByIdForUpdate(first.wallet.id))?.id).toBe(
        first.wallet.id,
      );
    });
  });
});
