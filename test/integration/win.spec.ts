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
import { ProcessWin } from '../../src/application/process-win.js';
import { ProcessBet } from '../../src/application/process-bet.js';
import type { UnitOfWork } from '../../src/application/ports/repositories.js';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
} from '../../src/domain/wager-transaction.js';
import { Money } from '../../src/domain/money.js';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry.js';
import {
  FailureCode,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction.js';
import { WagerModule } from '../../src/interfaces/http/wager.module.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';

const connect = () => MikroORM.init(createOrmConfig('dwp_test'));
let orm: Awaited<ReturnType<typeof connect>>;
let uow: PostgreSqlUnitOfWork;
let app: INestApplication;
async function seed(
  amount = '50.00',
  balance = '100.00',
): Promise<SubmitWagerInput> {
  const wallet = await new CreateWallet(uow).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  return {
    providerId: 'win-tests',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Win,
    money: { amount, currency: 'BRL' },
  };
}
const post = (input: unknown, key = crypto.randomUUID()) =>
  request(app.getHttpServer())
    .post('/wagering/transactions')
    .set('Idempotency-Key', key)
    .send(input as object);
async function state(walletId: string) {
  const [row] = await orm.em.fork().execute(
    `SELECT balance, version,
    (SELECT count(*) FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id WHERE e.wallet_id = w.id AND t.kind = 'WIN') AS win_entries,
    (SELECT sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries WHERE wallet_id = w.id)::numeric(20,2)::text AS reconstructed
    FROM wallets w WHERE id = ?`,
    [walletId],
  );
  return row;
}
async function bet(
  input: SubmitWagerInput,
  overrides: Partial<SubmitWagerInput> = {},
) {
  const payload: SubmitWagerInput = {
    ...input,
    kind: Kind.Bet,
    externalTransactionId: crypto.randomUUID(),
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
  const result = await new SubmitWager(uow).execute(
    payload,
    crypto.randomUUID(),
  );
  return { payload, result };
}

// O endpoint e os repositories são reais. A soma do ledger é conferida após cada cenário financeiro.
describe('WIN through HTTP and PostgreSQL', () => {
  it('rejects malformed or self-referencing requests before registration', async () => {
    const input = await seed();
    expect(
      (
        await post({
          ...input,
          referenceExternalTransactionId: input.externalTransactionId,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post({ ...input, referenceExternalTransactionId: '' })).status,
    ).toBe(400);
    expect(
      (
        await post({
          ...input,
          kind: Kind.Bet,
          referenceExternalTransactionId: 'bet',
        })
      ).status,
    ).toBe(400);
    expect((await state(input.walletId)).win_entries).toBe('0');
  });

  it('defends against a reference currency mismatch even though the schema prevents storing it', async () => {
    const input = await seed();
    const original = await bet(input);
    const invalid = WagerTransaction.rehydrate({
      ...original.payload,
      id: original.result.transactionId,
      idempotencyKey: 'reference',
      payloadHash: 'a'.repeat(64),
      money: Money.from({ amount: '25.00', currency: 'USD' }),
      createdAt: new Date(),
      status: Status.Processed,
      processedAt: new Date(),
    });
    const guarded: UnitOfWork = {
      read: (operation) => uow.read(operation),
      transaction: (operation) =>
        uow.transaction((session) =>
          operation({
            ...session,
            wagers: new Proxy(session.wagers, {
              get(target, property) {
                if (property === 'findByExternalId')
                  return async (provider: string, external: string) =>
                    external === original.payload.externalTransactionId
                      ? invalid
                      : target.findByExternalId(provider, external);
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          }),
        ),
    };
    // Só a leitura da referência é substituída; rejeição e ausência de crédito são verificadas no banco real.
    const result = await new SubmitWager(guarded).execute(
      {
        ...input,
        referenceExternalTransactionId: original.payload.externalTransactionId,
      },
      crypto.randomUUID(),
    );
    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(await state(input.walletId)).toEqual({
      balance: '75.00',
      version: 2,
      win_entries: '0',
      reconstructed: '75.00',
    });
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

  it('credits an independent prize, increments version and writes one CREDIT with exact balances', async () => {
    const input = await seed();
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(response.body.balance.amount).toBe('150.00');
    expect(await state(input.walletId)).toEqual({
      balance: '150.00',
      version: 2,
      win_entries: '1',
      reconstructed: '150.00',
    });
    const entry = await uow.read(({ ledger }) =>
      ledger.findByTransaction(input.walletId, response.body.transactionId),
    );
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.balanceBefore.toString()).toBe('100.00');
    expect(entry?.balanceAfter.toString()).toBe('150.00');
    const stored = await uow.read(({ wagers }) =>
      wagers.findById(response.body.transactionId),
    );
    expect(stored?.status).toBe(Status.Processed);
    expect(stored?.processedAt).toBeInstanceOf(Date);
  });

  it('accepts a processed BET reference and allows the prize to differ from the stake', async () => {
    const input = await seed();
    const original = await bet(input);
    const response = await post({
      ...input,
      referenceExternalTransactionId: original.payload.externalTransactionId,
    });
    expect(response.status).toBe(200);
    expect(response.body.balance.amount).toBe('125.00');
    const stored = await uow.read(({ wagers }) =>
      wagers.findById(response.body.transactionId),
    );
    expect(stored?.referenceTransactionId).toBe(original.result.transactionId);
    expect(await state(input.walletId)).toEqual({
      balance: '125.00',
      version: 3,
      win_entries: '1',
      reconstructed: '125.00',
    });
  });

  it('processes a zero prize without changing balance or version or creating ledger', async () => {
    const input = await seed('0.00');
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(await state(input.walletId)).toEqual({
      balance: '100.00',
      version: 1,
      win_entries: '0',
      reconstructed: '100.00',
    });
  });

  it('preserves cents at the maximum monetary capacity', async () => {
    const input = await seed('0.01', '999999999999999999.98');
    const response = await post(input);
    expect(response.status).toBe(200);
    expect(response.body.balance.amount).toBe('999999999999999999.99');
  });

  it('rejects overflow without changing balance or ledger', async () => {
    const input = await seed('0.01', '999999999999999999.99');
    const response = await post(input);
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await state(input.walletId)).toEqual({
      balance: '999999999999999999.99',
      version: 1,
      win_entries: '0',
      reconstructed: '999999999999999999.99',
    });
  });

  it.each(['round', 'player', 'wallet', 'kind', 'rejected-bet', 'zero-round'])(
    'rejects an invalid reference (%s) without crediting',
    async (scenario) => {
      const input = await seed(scenario === 'zero-round' ? '0.00' : '50.00');
      let reference: {
        payload: SubmitWagerInput;
        result: { transactionId: string };
      };
      if (scenario === 'kind') {
        const payload = {
          ...input,
          externalTransactionId: crypto.randomUUID(),
        };
        reference = {
          payload,
          result: await new SubmitWager(uow).execute(
            payload,
            crypto.randomUUID(),
          ),
        };
      } else if (scenario === 'player' || scenario === 'wallet') {
        const different = await new CreateWallet(uow).execute({
          playerId:
            scenario === 'wallet' ? input.playerId : crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'USD' },
        });
        reference = await bet(
          { ...input, walletId: different.id, playerId: different.playerId },
          { money: { amount: '25.00', currency: 'USD' } },
        );
      } else
        reference = await bet(input, {
          ...(scenario === 'round' || scenario === 'zero-round'
            ? { roundId: 'another-round' }
            : {}),
          ...(scenario === 'rejected-bet'
            ? { money: { amount: '1000.00', currency: 'BRL' } }
            : {}),
        });
      const before = await state(input.walletId);
      const response = await post({
        ...input,
        referenceExternalTransactionId: reference.payload.externalTransactionId,
      });
      const failure = {
        round: 'ROUND_MISMATCH',
        player: 'PLAYER_MISMATCH',
        wallet: 'WALLET_MISMATCH',
        kind: 'INVALID_REFERENCE_KIND',
        'rejected-bet': 'REFERENCE_NOT_PROCESSED',
        'zero-round': 'ROUND_MISMATCH',
      }[scenario];
      expect(response.status).toBe(422);
      expect(response.body.failureCode).toBe(failure);
      expect(await state(input.walletId)).toEqual(before);
    },
  );

  it('keeps a missing reference pending and credits only after the BET arrives', async () => {
    const input = await seed();
    const external = crypto.randomUUID();
    const key = crypto.randomUUID();
    const payload = { ...input, referenceExternalTransactionId: external };
    const pending = await post(payload, key);
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');
    expect((await state(input.walletId)).win_entries).toBe('0');
    const replay = await post(payload, key);
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);
    await bet(input, { externalTransactionId: external });
    // Exercita a retomada do caso de uso; o worker agendado pertence à tarefa de referências fora de ordem.
    await new ProcessWin(uow).execute(pending.body.transactionId);
    const completed = await post(payload, key);
    expect(completed.status).toBe(200);
    expect(completed.body.balance.amount).toBe('125.00');
    expect(completed.body.idempotentReplay).toBe(true);
    expect(await state(input.walletId)).toEqual({
      balance: '125.00',
      version: 3,
      win_entries: '1',
      reconstructed: '125.00',
    });
  });

  it('waits for an existing pending BET before processing its WIN', async () => {
    const input = await seed();
    const id = crypto.randomUUID();
    const pendingBet = WagerTransaction.create({
      ...input,
      id,
      kind: Kind.Bet,
      externalTransactionId: id,
      idempotencyKey: `pending:${id}`,
      payloadHash: 'a'.repeat(64),
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      createdAt: new Date(),
    });
    await uow.transaction(({ wagers }) => wagers.create(pendingBet));
    const win = await post({ ...input, referenceExternalTransactionId: id });
    expect(win.status).toBe(202);
    await new ProcessBet(uow).execute(id);
    await new ProcessWin(uow).execute(win.body.transactionId);
    expect((await state(input.walletId)).balance).toBe('125.00');
  });

  it('does not resolve a reference belonging to another provider', async () => {
    const input = await seed();
    const original = await bet(input, { providerId: 'another-provider' });
    const response = await post({
      ...input,
      referenceExternalTransactionId: original.payload.externalTransactionId,
    });
    expect(response.status).toBe(202);
    expect((await state(input.walletId)).win_entries).toBe('0');
  });

  it('credits once under 50 duplicate submissions and replays the original balance after another WIN', async () => {
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
    await post({
      ...input,
      externalTransactionId: crypto.randomUUID(),
      money: { amount: '10.00', currency: 'BRL' },
    });
    const replay = await post(input, key);
    expect(replay.body.balance.amount).toBe('150.00');
    expect((await state(input.walletId)).balance).toBe('160.00');
    expect(
      (
        await post(
          { ...input, money: { amount: '75.00', currency: 'BRL' } },
          key,
        )
      ).status,
    ).toBe(409);
  });

  it('rolls back registration and credit if ledger persistence fails, then allows retry', async () => {
    const input = await seed();
    const key = crypto.randomUUID();
    const broken: UnitOfWork = {
      read: (op) => uow.read(op),
      transaction: (op) =>
        uow.transaction((session) =>
          op({
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
    expect(await state(input.walletId)).toEqual({
      balance: '100.00',
      version: 1,
      win_entries: '0',
      reconstructed: '100.00',
    });
    expect(
      await uow.read(({ wagers }) => wagers.findByIdempotencyKey(key)),
    ).toBeUndefined();
    expect((await post(input, key)).status).toBe(200);
  });

  it.each(['wallet', 'player', 'currency'])(
    'validates the WIN %s before registration',
    async (field) => {
      const input = await seed();
      const key = crypto.randomUUID();
      const changed = {
        ...input,
        ...(field === 'wallet' ? { walletId: crypto.randomUUID() } : {}),
        ...(field === 'player' ? { playerId: crypto.randomUUID() } : {}),
        ...(field === 'currency'
          ? { money: { amount: '50.00', currency: 'USD' } }
          : {}),
      };
      expect((await post(changed, key)).status).toBe(400);
      expect(
        await uow.read(({ wagers }) => wagers.findByIdempotencyKey(key)),
      ).toBeUndefined();
      expect((await state(input.walletId)).balance).toBe('100.00');
    },
  );
});
