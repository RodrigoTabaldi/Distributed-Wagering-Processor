import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money.js';
import { Wallet } from '../../src/domain/wallet.js';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction.js';
import {
  LedgerEntryEntity,
  WagerTransactionEntity,
  WalletEntity,
} from '../../src/infrastructure/persistence/entities.js';
import {
  ledgerFromRecord,
  ledgerToRecord,
  transactionFromRecord,
  transactionToRecord,
  walletFromRecord,
  walletToRecord,
} from '../../src/infrastructure/persistence/mappers.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';

// Testes usam exclusivamente dwp_test. Cada caso cria IDs próprios, sem apagar dados.
const config = createOrmConfig('dwp_test');
const connect = () => MikroORM.init(config);
let orm: Awaited<ReturnType<typeof connect>>;
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const sql = (query: string, params: unknown[] = []) =>
  orm.em.fork().execute(query, params);

// Aguarda a operação de verdade e confere o código SQLSTATE enviado pelo PostgreSQL.
async function expectSqlFailure(
  operation: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected PostgreSQL failure ${code}`);
}

async function seed(amount = '100.00') {
  const at = new Date();
  const transactionId = crypto.randomUUID();
  const { wallet, openingEntry } = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: money(amount),
    at,
    opening: { entryId: crypto.randomUUID(), transactionId },
  });
  const tx = WagerTransaction.createOpening({
    id: transactionId,
    providerId: 'internal',
    externalTransactionId: transactionId,
    idempotencyKey: `opening:${transactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'opening',
    gameId: 'opening',
    money: money(amount),
    createdAt: at,
  });
  tx.markProcessed(undefined, at);
  await orm.em.fork().transactional(async (em) => {
    em.persist(em.create(WalletEntity, walletToRecord(wallet)));
    // Os vínculos são IDs escalares; flush explícito respeita a ordem das foreign keys.
    // Todos os flushes continuam dentro da mesma transação e só há um commit ao final.
    await em.flush();
    em.persist(em.create(WagerTransactionEntity, transactionToRecord(tx, at)));
    await em.flush();
    if (!openingEntry) throw new Error('Seed requires positive opening');
    em.persist(em.create(LedgerEntryEntity, ledgerToRecord(openingEntry)));
  });
  return { wallet, tx, openingEntry: openingEntry! };
}

describe('PostgreSQL persistence', () => {
  beforeAll(async () => {
    if (config.dbName !== 'dwp_test')
      throw new Error('Integration tests require dwp_test');
    orm = await MikroORM.init(config);
    await orm.migrator.up();
  });
  afterAll(async () => {
    if (orm) await orm.close();
  });

  // Migration down é testada em schema descartável, sem remover as tabelas de dwp_test.
  it('applies, reverses and reapplies the migration in an isolated schema', async () => {
    const schema = `migration_test_${crypto.randomUUID().replaceAll('-', '')}`;
    await sql(`CREATE SCHEMA "${schema}"`);
    try {
      await orm.migrator.up({ schema });
      expect(
        (
          await sql(`SELECT to_regclass(?) AS table_name`, [
            `${schema}.wallets`,
          ])
        )[0].table_name,
      ).not.toBeNull();
      await orm.migrator.down({ schema, to: 0 });
      expect(
        (
          await sql(`SELECT to_regclass(?) AS table_name`, [
            `${schema}.wallets`,
          ])
        )[0].table_name,
      ).toBeNull();
      await orm.migrator.up({ schema });
      await orm.migrator.down({ schema, to: 0 });
    } finally {
      // Remove somente o schema identificado acima; RESTRICT impede apagar objetos esquecidos.
      await sql(`DROP TABLE IF EXISTS "${schema}".mikro_orm_migrations`);
      await sql(`DROP SCHEMA "${schema}" RESTRICT`);
    }
  });

  it('round-trips wallet, transaction and ledger through MikroORM without losing cents', async () => {
    const { wallet, tx, openingEntry } = await seed('9007199254740993.01');
    const em = orm.em.fork();
    const row = await em.findOneOrFail(WalletEntity, { id: wallet.id });
    expect(typeof row.balance).toBe('string');
    expect(walletFromRecord(row).balance.toString()).toBe(
      '9007199254740993.01',
    );
    const transaction = transactionFromRecord(
      await em.findOneOrFail(WagerTransactionEntity, { id: tx.id }),
    );
    expect(transaction.money.toString()).toBe('9007199254740993.01');
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    const entry = ledgerFromRecord(
      await em.findOneOrFail(LedgerEntryEntity, { id: openingEntry.id }),
    );
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  it('rejects a second wallet for the same player and currency', async () => {
    const { wallet } = await seed();
    await expectSqlFailure(
      sql(`INSERT INTO wallets VALUES (?, ?, 'BRL', 0, 1, now(), now())`, [
        crypto.randomUUID(),
        wallet.playerId,
      ]),
      '23505',
    );
  });

  it.each(['-0.01', 'NaN', 'Infinity'])(
    'rejects invalid wallet balance %s in SQL',
    async (balance) => {
      const { wallet } = await seed();
      await expectSqlFailure(
        sql('UPDATE wallets SET balance = ? WHERE id = ?', [
          balance,
          wallet.id,
        ]),
        balance === 'Infinity' ? '22003' : '23514',
      );
    },
  );

  it('rejects changes of balance without a matching ledger at commit', async () => {
    const { wallet } = await seed();
    await expectSqlFailure(
      sql('UPDATE wallets SET balance = ? WHERE id = ?', ['90.00', wallet.id]),
      '23514',
    );
    expect(
      (await sql('SELECT balance FROM wallets WHERE id = ?', [wallet.id]))[0]
        .balance,
    ).toBe('100.00');
  });

  it.each(['idempotency_key', 'external_transaction_id'])(
    'enforces persistent uniqueness of %s',
    async (field) => {
      const { tx } = await seed();
      const id = crypto.randomUUID();
      const key =
        field === 'idempotency_key' ? tx.idempotencyKey : `other:${id}`;
      const external =
        field === 'external_transaction_id' ? tx.externalTransactionId : id;
      await expectSqlFailure(
        sql(
          `INSERT INTO wager_transactions
      (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,created_at,updated_at)
      VALUES (?, 'internal', ?, ?, ?, ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', now(), now())`,
          [id, external, key, 'a'.repeat(64), tx.walletId, tx.playerId],
        ),
        '23505',
      );
    },
  );

  // Constraints compostas impedem vincular uma transação ao jogador/moeda errados.
  it('rejects a transaction with a different player', async () => {
    const { tx } = await seed();
    await expectSqlFailure(
      sql(
        `INSERT INTO wager_transactions
      SELECT ?,provider_id,?, ?,payload_hash,wallet_id,?,round_id,game_id,kind,amount,currency,status,
      reference_external_transaction_id,reference_transaction_id,failure_code,processed_at,observed_balance,created_at,updated_at
      FROM wager_transactions WHERE id = ?`,
        [
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          tx.id,
        ],
      ),
      '23503',
    );
  });

  it('allows only one ledger entry per wallet and transaction', async () => {
    const { openingEntry } = await seed();
    await expectSqlFailure(
      sql(
        `INSERT INTO wallet_ledger_entries SELECT ?,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,created_at
      FROM wallet_ledger_entries WHERE id = ?`,
        [crypto.randomUUID(), openingEntry.id],
      ),
      '23505',
    );
  });

  it.each(['UPDATE', 'DELETE'])(
    'blocks ledger %s through direct SQL',
    async (operation) => {
      const { openingEntry } = await seed();
      const query =
        operation === 'UPDATE'
          ? 'UPDATE wallet_ledger_entries SET amount = amount WHERE id = ?'
          : 'DELETE FROM wallet_ledger_entries WHERE id = ?';
      await expectSqlFailure(sql(query, [openingEntry.id]), '23514');
    },
  );

  it('blocks ledger TRUNCATE', async () => {
    await expectSqlFailure(sql('TRUNCATE wallet_ledger_entries'), '23514');
  });

  it('blocks changes of terminal transaction state and business payload', async () => {
    const { tx } = await seed();
    await expectSqlFailure(
      sql(
        `UPDATE wager_transactions SET status = 'PENDING', processed_at = NULL WHERE id = ?`,
        [tx.id],
      ),
      '23514',
    );
    await expectSqlFailure(
      sql('UPDATE wager_transactions SET amount = 50 WHERE id = ?', [tx.id]),
      '23514',
    );
  });

  it('rolls back all writes when ledger arithmetic is invalid', async () => {
    const { wallet, openingEntry } = await seed();
    const id = crypto.randomUUID();
    await expectSqlFailure(
      orm.em.fork().transactional(async (em) => {
        await em.execute(
          'UPDATE wallets SET balance = 90, version = version + 1 WHERE id = ?',
          [wallet.id],
        );
        await em.execute(
          `INSERT INTO wager_transactions
        (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,processed_at,created_at,updated_at)
        VALUES (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', 'BET', 10, 'BRL', 'PROCESSED', now(), now(), now())`,
          [id, id, id, 'a'.repeat(64), wallet.id, wallet.playerId],
        );
        await em.execute(
          `INSERT INTO wallet_ledger_entries VALUES (?, ?, ?, 'DEBIT', 10, 'BRL', 100, 99, now())`,
          [crypto.randomUUID(), wallet.id, id],
        );
      }),
      '23514',
    );
    expect(
      (
        await sql('SELECT balance, version FROM wallets WHERE id = ?', [
          wallet.id,
        ])
      )[0],
    ).toMatchObject({ balance: '100.00', version: 1 });
    expect(
      (await sql('SELECT id FROM wager_transactions WHERE id = ?', [id]))
        .length,
    ).toBe(0);
    expect(
      (
        await sql('SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?', [
          wallet.id,
        ])
      ).map((row) => row.id),
    ).toEqual([openingEntry.id]);
  });

  it('requires a ledger for processed financial transactions and none for LOSS', async () => {
    const { wallet } = await seed();
    const insert = async (kind: string) => {
      const id = crypto.randomUUID();
      await sql(
        `INSERT INTO wager_transactions
        (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,processed_at,created_at,updated_at)
        VALUES (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', ?, 10, 'BRL', 'PROCESSED', now(), now(), now())`,
        [id, id, id, 'a'.repeat(64), wallet.id, wallet.playerId, kind],
      );
      return id;
    };
    await expectSqlFailure(insert('BET'), '23514');
    const lossId = await insert('LOSS');
    expect(
      (
        await sql(
          'SELECT id FROM wallet_ledger_entries WHERE transaction_id = ?',
          [lossId],
        )
      ).length,
    ).toBe(0);
  });

  // Duas reversões com IDs diferentes ainda disputam a mesma referência no banco.
  it('prevents a second processed refund while allowing rejected attempts', async () => {
    const { wallet } = await seed();
    const betId = crypto.randomUUID();
    const refundId = crypto.randomUUID();
    const insertOperation = async (
      em: typeof orm.em,
      id: string,
      kind: string,
      referenceId?: string,
      status = 'PROCESSED',
    ) => {
      await em.execute(
        `INSERT INTO wager_transactions
        (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,reference_external_transaction_id,reference_transaction_id,failure_code,processed_at,created_at,updated_at)
        VALUES (?, 'provider', ?, ?, ?, ?, ?, 'round', 'game', ?, 10, 'BRL', ?, ?, ?, ?, ?, now(), now())`,
        [
          id,
          id,
          id,
          'a'.repeat(64),
          wallet.id,
          wallet.playerId,
          kind,
          status,
          referenceId ?? null,
          referenceId ?? null,
          status === 'REJECTED' ? 'REFERENCE_ALREADY_REFUNDED' : null,
          status === 'PROCESSED' ? new Date() : null,
        ],
      );
    };
    await orm.em.fork().transactional(async (em) => {
      await insertOperation(em, betId, 'BET');
      await em.execute(
        `INSERT INTO wallet_ledger_entries VALUES (?, ?, ?, 'DEBIT', 10, 'BRL', 100, 90, now())`,
        [crypto.randomUUID(), wallet.id, betId],
      );
      await em.execute(
        'UPDATE wallets SET balance = 90, version = version + 1 WHERE id = ?',
        [wallet.id],
      );
    });
    await orm.em.fork().transactional(async (em) => {
      await insertOperation(em, refundId, 'REFUND', betId);
      await em.execute(
        `INSERT INTO wallet_ledger_entries VALUES (?, ?, ?, 'CREDIT', 10, 'BRL', 90, 100, now())`,
        [crypto.randomUUID(), wallet.id, refundId],
      );
      await em.execute(
        'UPDATE wallets SET balance = 100, version = version + 1 WHERE id = ?',
        [wallet.id],
      );
    });
    await expectSqlFailure(
      orm.em
        .fork()
        .transactional((em) =>
          insertOperation(em, crypto.randomUUID(), 'REFUND', betId),
        ),
      '23505',
    );
    await orm.em.fork().transactional(async (em) => {
      await insertOperation(
        em,
        crypto.randomUUID(),
        'REFUND',
        betId,
        'REJECTED',
      );
      await insertOperation(
        em,
        crypto.randomUUID(),
        'REFUND',
        betId,
        'REJECTED',
      );
    });
    expect(
      (await sql('SELECT balance FROM wallets WHERE id = ?', [wallet.id]))[0]
        .balance,
    ).toBe('100.00');
  });
});
