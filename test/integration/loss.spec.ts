import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import { CreateWallet } from '../../src/application/create-wallet.js';
import {
  ProcessLoss,
  InvalidLossError,
} from '../../src/application/process-loss.js';
import {
  SubmitWager,
  type SubmitWagerInput,
} from '../../src/application/submit-wager.js';
import type { UnitOfWork } from '../../src/application/ports/repositories.js';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  InvalidTransactionStateError,
} from '../../src/domain/wager-transaction.js';
import { WagerModule } from '../../src/interfaces/http/wager.module.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';

const connect = () => MikroORM.init(createOrmConfig('dwp_test'));
let orm: Awaited<ReturnType<typeof connect>>;
let uow: PostgreSqlUnitOfWork;
let app: INestApplication;
async function seed(
  amount = '0.00',
  balance = '100.00',
): Promise<SubmitWagerInput> {
  const wallet = await new CreateWallet(uow).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  return {
    providerId: 'loss-tests',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Loss,
    money: { amount, currency: 'BRL' },
  };
}
const post = (input: unknown, key = crypto.randomUUID()) =>
  request(app.getHttpServer())
    .post('/wagering/transactions')
    .set('Idempotency-Key', key)
    .send(input as object);

// Compara também a data da wallet e TODO o ledger, para detectar qualquer movimentação indevida.
async function snapshot(walletId: string) {
  const [row] = await orm.em.fork().execute(
    `SELECT balance, version, updated_at::text AS updated_at,
    (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = w.id) AS entries,
    COALESCE((SELECT sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries WHERE wallet_id = w.id), 0)::numeric(20,2)::text AS reconstructed
    FROM wallets w WHERE id = ?`,
    [walletId],
  );
  return row;
}

describe('LOSS through HTTP and PostgreSQL', () => {
  beforeAll(async () => {
    orm = await connect();
    await orm.migrator.up();
    uow = new PostgreSqlUnitOfWork(orm);
    const module = await Test.createTestingModule({ imports: [WagerModule] })
      .overrideProvider(MikroORM)
      .useValue(orm)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    if (app) await app.close();
    else if (orm) await orm.close();
  });

  // Valor positivo é informativo: a derrota não desconta a aposta uma segunda vez.
  it.each(['0.00', '25.00', '999999999999999999.99'])(
    'processes LOSS amount %s without changing wallet or ledger',
    async (amount) => {
      const input = await seed(amount);
      const before = await snapshot(input.walletId);
      const response = await post(input);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(await snapshot(input.walletId)).toEqual(before);
      const tx = await uow.read(({ wagers }) =>
        wagers.findById(response.body.transactionId),
      );
      expect(tx?.kind).toBe(Kind.Loss);
      expect(tx?.status).toBe(Status.Processed);
      expect(tx?.processedAt).toBeInstanceOf(Date);
      expect(tx?.money.toString()).toBe(amount);
      expect(
        await uow.read(({ ledger }) =>
          ledger.findByTransaction(input.walletId, response.body.transactionId),
        ),
      ).toBeUndefined();
    },
  );

  it('records a loss after BET without subtracting again and replays its original balance', async () => {
    const input = await seed('25.00');
    const key = crypto.randomUUID();
    await new SubmitWager(uow).execute(
      { ...input, kind: Kind.Bet, externalTransactionId: crypto.randomUUID() },
      crypto.randomUUID(),
    );
    const before = await snapshot(input.walletId);
    const original = await post(input, key);
    expect(original.body.balance.amount).toBe('75.00');
    expect(await snapshot(input.walletId)).toEqual(before);
    await new SubmitWager(uow).execute(
      {
        ...input,
        kind: Kind.Win,
        externalTransactionId: crypto.randomUUID(),
        money: { amount: '10.00', currency: 'BRL' },
      },
      crypto.randomUUID(),
    );
    const replay = await post(input, key);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect((await snapshot(input.walletId)).balance).toBe('85.00');
  });

  it('processes LOSS on a zero balance without creating even an opening ledger', async () => {
    const input = await seed('25.00', '0.00');
    const before = await snapshot(input.walletId);
    expect((await post(input)).status).toBe(200);
    expect(await snapshot(input.walletId)).toEqual(before);
    expect(before.entries).toBe('0');
    expect(before.balance).toBe(before.reconstructed);
  });

  it('registers one LOSS under 50 simultaneous duplicate submissions with no ledger change', async () => {
    const input = await seed();
    const key = crypto.randomUUID();
    const before = await snapshot(input.walletId);
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => post(input, key)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      responses.filter((response) => response.body.idempotentReplay === false),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.body.idempotentReplay === true),
    ).toHaveLength(49);
    expect(
      new Set(responses.map((response) => response.body.transactionId)).size,
    ).toBe(1);
    const [row] = await orm.em
      .fork()
      .execute(
        "SELECT count(*) AS losses FROM wager_transactions WHERE wallet_id = ? AND kind = 'LOSS'",
        [input.walletId],
      );
    expect(row.losses).toBe('1');
    expect(await snapshot(input.walletId)).toEqual(before);
  });

  it('conflicts if a key changes the LOSS amount or operation kind', async () => {
    const input = await seed();
    const key = crypto.randomUUID();
    const before = await snapshot(input.walletId);
    await post(input, key);
    expect(
      (
        await post(
          { ...input, money: { amount: '25.00', currency: 'BRL' } },
          key,
        )
      ).status,
    ).toBe(409);
    expect((await post({ ...input, kind: Kind.Win }, key)).status).toBe(409);
    expect(await snapshot(input.walletId)).toEqual(before);
  });

  it.each(['wallet', 'player', 'currency', 'reference', 'negative'])(
    'rejects invalid LOSS %s before registration',
    async (field) => {
      const input = await seed();
      const key = crypto.randomUUID();
      const changed = {
        ...input,
        ...(field === 'wallet' ? { walletId: crypto.randomUUID() } : {}),
        ...(field === 'player' ? { playerId: crypto.randomUUID() } : {}),
        ...(field === 'currency'
          ? { money: { amount: '0.00', currency: 'USD' } }
          : {}),
        ...(field === 'reference'
          ? { referenceExternalTransactionId: 'bet' }
          : {}),
        ...(field === 'negative'
          ? { money: { amount: '-1.00', currency: 'BRL' } }
          : {}),
      };
      const before = await snapshot(input.walletId);
      expect((await post(changed, key)).status).toBe(400);
      expect(
        await uow.read(({ wagers }) => wagers.findByIdempotencyKey(key)),
      ).toBeUndefined();
      expect(await snapshot(input.walletId)).toEqual(before);
    },
  );

  it('rolls back registration when result persistence fails and allows retry', async () => {
    const input = await seed();
    const key = crypto.randomUUID();
    const before = await snapshot(input.walletId);
    const broken: UnitOfWork = {
      read: (operation) => uow.read(operation),
      transaction: (operation) =>
        uow.transaction((session) =>
          operation({
            ...session,
            wagers: new Proxy(session.wagers, {
              get(target, property) {
                if (property === 'updateState')
                  return async () => {
                    throw new Error('Injected state failure');
                  };
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          }),
        ),
    };
    let caught: unknown;
    try {
      await new SubmitWager(broken).execute(input, key);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(
      await uow.read(({ wagers }) => wagers.findByIdempotencyKey(key)),
    ).toBeUndefined();
    expect(await snapshot(input.walletId)).toEqual(before);
    expect((await post(input, key)).status).toBe(200);
  });

  it('does not transition a processed LOSS again at the low-level processor', async () => {
    const input = await seed();
    const response = await post(input);
    const before = await snapshot(input.walletId);
    let caught: unknown;
    try {
      await new ProcessLoss(uow).execute(response.body.transactionId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidTransactionStateError);
    expect(await snapshot(input.walletId)).toEqual(before);
  });

  it('does not process an absent transaction or another operation kind as LOSS', async () => {
    const input = await seed();
    const win = await new SubmitWager(uow).execute(
      { ...input, kind: Kind.Win },
      crypto.randomUUID(),
    );
    const before = await snapshot(input.walletId);
    for (const id of [crypto.randomUUID(), win.transactionId]) {
      let caught: unknown;
      try {
        await new ProcessLoss(uow).execute(id);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidLossError);
    }
    expect(await snapshot(input.walletId)).toEqual(before);
  });
});
