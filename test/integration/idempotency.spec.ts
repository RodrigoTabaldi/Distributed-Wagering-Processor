import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import { CreateWallet } from '../../src/application/create-wallet.js';
import {
  SubmitWager,
  type SubmitWagerInput,
} from '../../src/application/submit-wager.js';
import type { UnitOfWork } from '../../src/application/ports/repositories.js';
import { WagerTransactionKind } from '../../src/domain/wager-transaction.js';
import { IdempotencyConflictError } from '../../src/domain/wager-transaction.js';
import { WagerModule } from '../../src/interfaces/http/wager.module.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';

const connect = () => MikroORM.init(createOrmConfig('dwp_test'));
let orm: Awaited<ReturnType<typeof connect>>;
let uow: PostgreSqlUnitOfWork;
let app: INestApplication;
async function seed(
  amount = '25.00',
  balance = '100.00',
): Promise<SubmitWagerInput> {
  const wallet = await new CreateWallet(uow).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  return {
    providerId: 'idempotency',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: 'BRL' },
  };
}
function post(input: unknown, key?: string) {
  const req = request(app.getHttpServer()).post('/wagering/transactions');
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send(input as object);
}
async function financialState(walletId: string) {
  const [row] = await orm.em.fork().execute(
    `SELECT balance, version,
    (SELECT count(*) FROM wager_transactions WHERE wallet_id = w.id AND kind = 'BET') AS bets,
    (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = w.id AND direction = 'DEBIT') AS debits,
    (SELECT sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries WHERE wallet_id = w.id)::numeric(20,2)::text AS reconstructed
    FROM wallets w WHERE id = ?`,
    [walletId],
  );
  return row;
}

describe('Persistent BET idempotency through HTTP', () => {
  it('arbitrates a forced UNIQUE race across wallets after rolling back the loser', async () => {
    const a = await seed();
    const b = await seed();
    const key = crypto.randomUUID();
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const simultaneous: UnitOfWork = {
      read: (operation) => uow.read(operation),
      transaction: (operation) =>
        uow.transaction((session) =>
          operation({
            ...session,
            wagers: new Proxy(session.wagers, {
              get(target, property) {
                if (property === 'create')
                  return async (...args: Parameters<typeof target.create>) => {
                    // Ambos chegam ao INSERT sem vencedor salvo; UNIQUE decide qual commit é permitido.
                    if (++arrivals === 2) release();
                    await gate;
                    return target.create(...args);
                  };
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          }),
        ),
    };
    const submit = new SubmitWager(simultaneous);
    const results = await Promise.allSettled([
      submit.execute(a, key),
      submit.execute(b, key),
    ]);
    expect(arrivals).toBe(2);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const loser = results.find((result) => result.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason).toBeInstanceOf(
      IdempotencyConflictError,
    );
    const states = await Promise.all([
      financialState(a.walletId),
      financialState(b.walletId),
    ]);
    expect(
      states.map((state) => state.debits).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['0', '1']);
    expect(states.every((state) => state.balance === state.reconstructed)).toBe(
      true,
    );
  });
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

  it('requires the Idempotency-Key header and rejects malformed payloads before persistence', async () => {
    const input = await seed();
    expect((await post(input)).status).toBe(400);
    expect((await post(input, '')).status).toBe(400);
    expect(
      (
        await post(
          { ...input, money: { amount: 25, currency: 'BRL' } },
          'invalid',
        )
      ).status,
    ).toBe(400);
    expect((await post({ ...input, kind: 'OPENING' }, 'invalid')).status).toBe(
      400,
    );
    expect((await post({ ...input, extra: true }, 'invalid')).status).toBe(400);
    expect((await financialState(input.walletId)).bets).toBe('0');
  });

  it('replays the original balance after another bet has changed the wallet', async () => {
    const input = await seed();
    const key = crypto.randomUUID();
    const original = await post(input, key);
    const next = await post(
      {
        ...input,
        externalTransactionId: crypto.randomUUID(),
        money: { amount: '10.00', currency: 'BRL' },
      },
      crypto.randomUUID(),
    );
    expect(original.status).toBe(200);
    expect(original.body.idempotentReplay).toBe(false);
    expect(next.body.balance.amount).toBe('65.00');
    // JSON reordenado e UUIDs em maiúsculas continuam representando o mesmo negócio.
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    reversed.money = { currency: 'BRL', amount: '25.00' };
    reversed.playerId = input.playerId.toUpperCase();
    reversed.walletId = input.walletId.toUpperCase();
    const replay = await post(reversed, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('75.00');
    expect(await financialState(input.walletId)).toEqual({
      balance: '65.00',
      version: 3,
      bets: '2',
      debits: '2',
      reconstructed: '65.00',
    });
  });

  it.each(['amount', 'provider', 'round', 'external'])(
    'returns 409 when the same key changes %s',
    async (field) => {
      const input = await seed();
      const key = crypto.randomUUID();
      await post(input, key);
      const changed = {
        ...input,
        ...(field === 'amount'
          ? { money: { amount: '50.00', currency: 'BRL' } }
          : {}),
        ...(field === 'provider' ? { providerId: 'another' } : {}),
        ...(field === 'round' ? { roundId: 'another' } : {}),
        ...(field === 'external'
          ? { externalTransactionId: crypto.randomUUID() }
          : {}),
      };
      const conflict = await post(changed, key);
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
      expect((await financialState(input.walletId)).debits).toBe('1');
    },
  );

  it('does not execute the same provider/external ID under another key', async () => {
    const input = await seed();
    await post(input, crypto.randomUUID());
    expect((await post(input, crypto.randomUUID())).status).toBe(409);
    expect((await financialState(input.walletId)).debits).toBe('1');
  });

  it('records rejection and replays its original balance after a later debit', async () => {
    const input = await seed('100.01');
    const key = crypto.randomUUID();
    const original = await post(input, key);
    expect(original.status).toBe(422);
    expect(original.body.failureCode).toBe('INSUFFICIENT_BALANCE');
    await post(
      {
        ...input,
        externalTransactionId: crypto.randomUUID(),
        money: { amount: '25.00', currency: 'BRL' },
      },
      crypto.randomUUID(),
    );
    const replay = await post(input, key);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('100.00');
    expect((await financialState(input.walletId)).debits).toBe('1');
  });

  it('handles 50 simultaneous HTTP submissions with one debit and 49 replays', async () => {
    const input = await seed();
    const key = crypto.randomUUID();
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
    expect(await financialState(input.walletId)).toEqual({
      balance: '75.00',
      version: 2,
      bets: '1',
      debits: '1',
      reconstructed: '75.00',
    });
  });

  // Esta corrida usa wallets diferentes para exercitar UNIQUE, além do lock por wallet.
  it('resolves a conflicting key raced across different wallets with only one winner', async () => {
    const a = await seed();
    const b = await seed();
    const key = crypto.randomUUID();
    const responses = await Promise.all([post(a, key), post(b, key)]);
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([200, 409]);
    const states = await Promise.all([
      financialState(a.walletId),
      financialState(b.walletId),
    ]);
    expect(
      states.map((state) => state.debits).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['0', '1']);
  });

  it('preserves the result after reopening ORM in a new connection pool', async () => {
    const input = await seed();
    const key = crypto.randomUUID();
    const original = await post(input, key);
    const restarted = await connect();
    try {
      const replay = await new SubmitWager(
        new PostgreSqlUnitOfWork(restarted),
      ).execute(input, key);
      expect(replay).toEqual({ ...original.body, idempotentReplay: true });
    } finally {
      await restarted.close();
    }
  });

  it('rolls back registration and debit on failure, allowing a clean retry with the same key', async () => {
    const input = await seed();
    const key = crypto.randomUUID();
    const broken: UnitOfWork = {
      read: (operation) => uow.read(operation),
      transaction: (operation) =>
        uow.transaction((session) =>
          operation({
            ...session,
            ledger: {
              create: async () => {
                throw new Error('Injected ledger failure');
              },
              findByTransaction: session.ledger.findByTransaction.bind(
                session.ledger,
              ),
              findByWallet: session.ledger.findByWallet.bind(session.ledger),
            },
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
    expect(await financialState(input.walletId)).toEqual({
      balance: '100.00',
      version: 1,
      bets: '0',
      debits: '0',
      reconstructed: '100.00',
    });
    const retry = await post(input, key);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(false);
  });
});
