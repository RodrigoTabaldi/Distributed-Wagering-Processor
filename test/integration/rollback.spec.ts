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
import { ProcessRollback } from '../../src/application/process-rollback.js';
import { ProcessBet } from '../../src/application/process-bet.js';
import type { UnitOfWork } from '../../src/application/ports/repositories.js';
import { Money } from '../../src/domain/money.js';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction.js';
import { WagerModule } from '../../src/interfaces/http/wager.module.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';

const connect = () => MikroORM.init(createOrmConfig('dwp_test'));
let orm: Awaited<ReturnType<typeof connect>>;
let uow: PostgreSqlUnitOfWork;
let app: INestApplication;
const post = (input: unknown, key = crypto.randomUUID()) =>
  request(app.getHttpServer())
    .post('/wagering/transactions')
    .set('Idempotency-Key', key)
    .send(input as object);
async function seed(amount = '25.00') {
  const wallet = await new CreateWallet(uow).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const bet: SubmitWagerInput = {
    providerId: 'rollback-tests',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: { amount, currency: 'BRL' },
  };
  const result = await new SubmitWager(uow).execute(bet, crypto.randomUUID());
  const rollback: SubmitWagerInput = {
    ...bet,
    externalTransactionId: crypto.randomUUID(),
    kind: Kind.Rollback,
    referenceExternalTransactionId: bet.externalTransactionId,
  };
  return { bet, result, rollback };
}
async function state(walletId: string) {
  const [row] = await orm.em.fork().execute(
    `SELECT balance, version, updated_at::text AS updated_at,
    (SELECT count(*) FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id WHERE e.wallet_id = w.id AND t.kind = 'ROLLBACK') AS rollback_entries,
    (SELECT sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries WHERE wallet_id = w.id)::numeric(20,2)::text AS reconstructed
    FROM wallets w WHERE id = ?`,
    [walletId],
  );
  return row;
}

// Todos os efeitos financeiros são verificados no PostgreSQL, com reconciliação pelo ledger.
describe('ROLLBACK through HTTP and PostgreSQL', () => {
  it('rolls back a WIN debit and its ledger if state persistence fails after the ledger INSERT', async () => {
    const { rollback } = await seed();
    const source: SubmitWagerInput = {
      ...rollback,
      kind: Kind.Win,
      referenceExternalTransactionId: undefined,
      externalTransactionId: crypto.randomUUID(),
    };
    await new SubmitWager(uow).execute(source, crypto.randomUUID());
    const payload = {
      ...rollback,
      referenceExternalTransactionId: source.externalTransactionId,
    };
    const key = crypto.randomUUID();
    const before = await state(rollback.walletId);
    const broken: UnitOfWork = {
      read: (op) => uow.read(op),
      transaction: (op) =>
        uow.transaction((session) =>
          op({
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
      await new SubmitWager(broken).execute(payload, key);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(await state(rollback.walletId)).toEqual(before);
    expect(
      await uow.read(({ wagers }) => wagers.findByIdempotencyKey(key)),
    ).toBeUndefined();
    expect((await post(payload, key)).status).toBe(200);
  });
  // WIN e REFUND criam créditos; desfazê-los exige um DEBIT do mesmo valor.
  it.each([Kind.Win, Kind.Refund])(
    'reverses a processed %s with an exact DEBIT',
    async (kind) => {
      const { rollback, bet } = await seed();
      const source: SubmitWagerInput = {
        ...rollback,
        kind,
        externalTransactionId: crypto.randomUUID(),
        referenceExternalTransactionId:
          kind === Kind.Refund ? bet.externalTransactionId : undefined,
        money: {
          amount: kind === Kind.Win ? '50.00' : '25.00',
          currency: 'BRL',
        },
      };
      const original = await new SubmitWager(uow).execute(
        source,
        crypto.randomUUID(),
      );
      const payload: SubmitWagerInput = {
        ...rollback,
        money: source.money,
        referenceExternalTransactionId: source.externalTransactionId,
      };
      const response = await post(payload);
      expect(response.status).toBe(200);
      expect(response.body.balance.amount).toBe('75.00');
      const entry = await uow.read(({ ledger }) =>
        ledger.findByTransaction(payload.walletId, response.body.transactionId),
      );
      expect(entry?.direction).toBe(LedgerDirection.Debit);
      expect(entry?.balanceBefore.toString()).toBe(
        kind === Kind.Win ? '125.00' : '100.00',
      );
      expect(entry?.balanceAfter.toString()).toBe('75.00');
      const tx = await uow.read(({ wagers }) =>
        wagers.findById(response.body.transactionId),
      );
      expect(tx?.referenceTransactionId).toBe(original.transactionId);
      expect(await state(payload.walletId)).toMatchObject({
        balance: '75.00',
        version: 4,
        rollback_entries: '1',
        reconstructed: '75.00',
      });
    },
  );

  it.each([Kind.Win, Kind.Refund])(
    'rejects rollback of %s when its credited money has been spent',
    async (kind) => {
      const { rollback, bet } = await seed();
      const source: SubmitWagerInput = {
        ...rollback,
        kind,
        externalTransactionId: crypto.randomUUID(),
        referenceExternalTransactionId:
          kind === Kind.Refund ? bet.externalTransactionId : undefined,
        money: {
          amount: kind === Kind.Win ? '50.00' : '25.00',
          currency: 'BRL',
        },
      };
      await new SubmitWager(uow).execute(source, crypto.randomUUID());
      await new SubmitWager(uow).execute(
        {
          ...bet,
          externalTransactionId: crypto.randomUUID(),
          money: {
            amount: kind === Kind.Win ? '125.00' : '100.00',
            currency: 'BRL',
          },
        },
        crypto.randomUUID(),
      );
      const payload = {
        ...rollback,
        money: source.money,
        referenceExternalTransactionId: source.externalTransactionId,
      };
      const key = crypto.randomUUID();
      const before = await state(rollback.walletId);
      const rejected = await post(payload, key);
      expect(rejected.status).toBe(422);
      expect(rejected.body.failureCode).toBe('REVERSAL_INSUFFICIENT_BALANCE');
      expect(rejected.body.failureCode).not.toBe('INSUFFICIENT_BALANCE');
      expect(await state(rollback.walletId)).toEqual(before);
      expect(before.balance).toBe('0.00');
      // O resultado rejeitado permanece estável em reenvios; outra tentativa válida pode usar outra chave.
      const replay = await post(payload, key);
      expect(replay.body).toEqual({ ...rejected.body, idempotentReplay: true });
      await new SubmitWager(uow).execute(
        {
          ...source,
          kind: Kind.Win,
          referenceExternalTransactionId: undefined,
          externalTransactionId: crypto.randomUUID(),
        },
        crypto.randomUUID(),
      );
      expect(
        (await post({ ...payload, externalTransactionId: crypto.randomUUID() }))
          .status,
      ).toBe(200);
      expect((await state(rollback.walletId)).balance).toBe('0.00');
    },
  );

  it('keeps an absent WIN pending and debits only after that WIN arrives', async () => {
    const { rollback } = await seed();
    const external = crypto.randomUUID();
    const response = await post({
      ...rollback,
      referenceExternalTransactionId: external,
    });
    expect(response.status).toBe(202);
    expect((await state(rollback.walletId)).balance).toBe('75.00');
    await new SubmitWager(uow).execute(
      {
        ...rollback,
        kind: Kind.Win,
        referenceExternalTransactionId: undefined,
        externalTransactionId: external,
      },
      crypto.randomUUID(),
    );
    await new ProcessRollback(uow).execute(response.body.transactionId);
    expect(await state(rollback.walletId)).toMatchObject({
      balance: '75.00',
      version: 4,
      rollback_entries: '1',
      reconstructed: '75.00',
    });
  });

  it('rolls back a zero WIN without a debit or version change', async () => {
    const { rollback } = await seed();
    const source: SubmitWagerInput = {
      ...rollback,
      kind: Kind.Win,
      referenceExternalTransactionId: undefined,
      externalTransactionId: crypto.randomUUID(),
      money: { amount: '0.00', currency: 'BRL' },
    };
    await new SubmitWager(uow).execute(source, crypto.randomUUID());
    const before = await state(rollback.walletId);
    expect(
      (
        await post({
          ...rollback,
          money: source.money,
          referenceExternalTransactionId: source.externalTransactionId,
        })
      ).status,
    ).toBe(200);
    expect(await state(rollback.walletId)).toEqual(before);
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

  it('rollbacks a processed BET exactly once and links one CREDIT to its reference', async () => {
    const { rollback, result } = await seed();
    const response = await post(rollback);
    expect(response.status).toBe(200);
    expect(response.body.balance.amount).toBe('100.00');
    expect(await state(rollback.walletId)).toMatchObject({
      balance: '100.00',
      version: 3,
      rollback_entries: '1',
      reconstructed: '100.00',
    });
    const tx = await uow.read(({ wagers }) =>
      wagers.findById(response.body.transactionId),
    );
    expect(tx?.status).toBe(Status.Processed);
    expect(tx?.referenceTransactionId).toBe(result.transactionId);
    const entry = await uow.read(({ ledger }) =>
      ledger.findByTransaction(rollback.walletId, response.body.transactionId),
    );
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.money.toString()).toBe('25.00');
    expect(entry?.balanceBefore.toString()).toBe('75.00');
    expect(entry?.balanceAfter.toString()).toBe('100.00');
  });

  it('replays the original result but rejects another ROLLBACK of the same BET', async () => {
    const { rollback } = await seed();
    const key = crypto.randomUUID();
    const original = await post(rollback, key);
    const before = await state(rollback.walletId);
    const second = await post({
      ...rollback,
      externalTransactionId: crypto.randomUUID(),
    });
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_ROLLED_BACK');
    expect(await state(rollback.walletId)).toEqual(before);
    await new SubmitWager(uow).execute(
      {
        ...rollback,
        referenceExternalTransactionId: undefined,
        kind: Kind.Bet,
        externalTransactionId: crypto.randomUUID(),
        money: { amount: '10.00', currency: 'BRL' },
      },
      crypto.randomUUID(),
    );
    const replay = await post(rollback, key);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('100.00');
    expect((await state(rollback.walletId)).balance).toBe('90.00');
  });

  it.each(['amount', 'round', 'kind', 'rejected-bet', 'player', 'wallet'])(
    'rejects invalid reference %s without changing wallet or ledger',
    async (scenario) => {
      const { rollback } = await seed(
        scenario === 'rejected-bet' ? '1000.00' : '25.00',
      );
      let payload = rollback;
      if (scenario === 'amount')
        payload = { ...rollback, money: { amount: '24.99', currency: 'BRL' } };
      if (scenario === 'round')
        payload = { ...rollback, roundId: 'another-round' };
      if (scenario === 'kind') {
        const loss: SubmitWagerInput = {
          ...rollback,
          kind: Kind.Loss,
          referenceExternalTransactionId: undefined,
          externalTransactionId: crypto.randomUUID(),
        };
        await new SubmitWager(uow).execute(loss, crypto.randomUUID());
        payload = {
          ...rollback,
          referenceExternalTransactionId: loss.externalTransactionId,
        };
      }
      if (scenario === 'player' || scenario === 'wallet') {
        const wallet = await new CreateWallet(uow).execute({
          playerId:
            scenario === 'wallet' ? rollback.playerId : crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'USD' },
        });
        const otherBet: SubmitWagerInput = {
          ...rollback,
          kind: Kind.Bet,
          referenceExternalTransactionId: undefined,
          externalTransactionId: crypto.randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: { amount: '25.00', currency: 'USD' },
        };
        await new SubmitWager(uow).execute(otherBet, crypto.randomUUID());
        payload = {
          ...rollback,
          referenceExternalTransactionId: otherBet.externalTransactionId,
        };
      }
      const before = await state(rollback.walletId);
      const response = await post(payload);
      const code = {
        amount: 'REFERENCE_AMOUNT_MISMATCH',
        round: 'ROUND_MISMATCH',
        kind: 'INVALID_REFERENCE_KIND',
        'rejected-bet': 'REFERENCE_NOT_PROCESSED',
        player: 'PLAYER_MISMATCH',
        wallet: 'WALLET_MISMATCH',
      }[scenario];
      expect(response.status).toBe(422);
      expect(response.body.failureCode).toBe(code);
      expect(await state(rollback.walletId)).toEqual(before);
      // Uma tentativa rejeitada por valor errado não consome o direito de devolver a BET.
      if (scenario === 'amount')
        expect(
          (
            await post({
              ...rollback,
              externalTransactionId: crypto.randomUUID(),
            })
          ).status,
        ).toBe(200);
    },
  );

  it.each(['provider', 'currency'])(
    'defends reference %s even if an adapter returns incompatible data',
    async (field) => {
      const { rollback, bet, result } = await seed();
      const invalid = WagerTransaction.rehydrate({
        ...bet,
        id: result.transactionId,
        idempotencyKey: 'reference',
        payloadHash: 'a'.repeat(64),
        createdAt: new Date(),
        status: Status.Processed,
        processedAt: new Date(),
        providerId: field === 'provider' ? 'another-provider' : bet.providerId,
        money: Money.from({
          amount: '25.00',
          currency: field === 'currency' ? 'USD' : 'BRL',
        }),
      });
      const guarded: UnitOfWork = {
        read: (op) => uow.read(op),
        transaction: (op) =>
          uow.transaction((session) =>
            op({
              ...session,
              wagers: new Proxy(session.wagers, {
                get(target, property) {
                  if (property === 'findByExternalId')
                    return async (provider: string, external: string) =>
                      external === bet.externalTransactionId
                        ? invalid
                        : target.findByExternalId(provider, external);
                  const value = Reflect.get(target, property);
                  return typeof value === 'function'
                    ? value.bind(target)
                    : value;
                },
              }),
            }),
          ),
      };
      // Só a leitura incompatível é simulada; rejeição persistida e ausência de crédito usam banco real.
      const before = await state(rollback.walletId);
      const outcome = await new SubmitWager(guarded).execute(
        rollback,
        crypto.randomUUID(),
      );
      expect(outcome.status).toBe(Status.Rejected);
      expect(outcome.failureCode).toBe(
        field === 'provider'
          ? FailureCode.ProviderMismatch
          : FailureCode.CurrencyMismatch,
      );
      expect(await state(rollback.walletId)).toEqual(before);
    },
  );

  it('requires a non-empty reference and rejects self reference before registration', async () => {
    const { rollback } = await seed();
    const before = await state(rollback.walletId);
    for (const reference of [undefined, '', rollback.externalTransactionId]) {
      const key = crypto.randomUUID();
      expect(
        (
          await post(
            { ...rollback, referenceExternalTransactionId: reference },
            key,
          )
        ).status,
      ).toBe(400);
      expect(
        await uow.read(({ wagers }) => wagers.findByIdempotencyKey(key)),
      ).toBeUndefined();
    }
    expect(await state(rollback.walletId)).toEqual(before);
  });

  it('waits for a missing BET and processes the ROLLBACK only after it arrives', async () => {
    const { rollback } = await seed();
    const external = crypto.randomUUID();
    const payload = { ...rollback, referenceExternalTransactionId: external };
    const response = await post(payload);
    const before = await state(rollback.walletId);
    expect(response.status).toBe(202);
    expect(response.body.status).toBe('PENDING_REFERENCE');
    expect(before.rollback_entries).toBe('0');
    await new SubmitWager(uow).execute(
      {
        ...rollback,
        kind: Kind.Bet,
        referenceExternalTransactionId: undefined,
        externalTransactionId: external,
      },
      crypto.randomUUID(),
    );
    await new ProcessRollback(uow).execute(response.body.transactionId);
    expect(await state(rollback.walletId)).toMatchObject({
      balance: '75.00',
      version: 4,
      rollback_entries: '1',
      reconstructed: '75.00',
    });
  });

  it('waits for an existing pending BET rather than rollbacking before its debit', async () => {
    const { rollback } = await seed();
    const id = crypto.randomUUID();
    const pending = WagerTransaction.create({
      ...rollback,
      referenceExternalTransactionId: undefined,
      id,
      kind: Kind.Bet,
      externalTransactionId: id,
      idempotencyKey: `pending:${id}`,
      payloadHash: 'a'.repeat(64),
      money: Money.from(rollback.money),
      createdAt: new Date(),
    });
    await uow.transaction(({ wagers }) => wagers.create(pending));
    const response = await post({
      ...rollback,
      referenceExternalTransactionId: id,
    });
    expect(response.status).toBe(202);
    await new ProcessBet(uow).execute(id);
    await new ProcessRollback(uow).execute(response.body.transactionId);
    expect((await state(rollback.walletId)).balance).toBe('75.00');
  });

  it('does not resolve a BET from another provider', async () => {
    const { rollback } = await seed();
    const before = await state(rollback.walletId);
    const response = await post({
      ...rollback,
      providerId: 'another-provider',
    });
    expect(response.status).toBe(202);
    expect(await state(rollback.walletId)).toEqual(before);
  });

  it('handles 50 duplicate rollbacks with one credit and 49 replays', async () => {
    const { rollback } = await seed();
    const key = crypto.randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => post(rollback, key)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      responses.filter((response) => response.body.idempotentReplay === false),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.body.idempotentReplay === true),
    ).toHaveLength(49);
    expect(await state(rollback.walletId)).toMatchObject({
      balance: '100.00',
      version: 3,
      rollback_entries: '1',
      reconstructed: '100.00',
    });
  });

  it('allows one winner among different concurrent ROLLBACK operations of the same BET', async () => {
    const { rollback } = await seed();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post({ ...rollback, externalTransactionId: crypto.randomUUID() }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(
      responses.filter(
        (response) =>
          response.status === 422 &&
          response.body.failureCode === 'REFERENCE_ALREADY_ROLLED_BACK',
      ),
    ).toHaveLength(9);
    expect(await state(rollback.walletId)).toMatchObject({
      balance: '100.00',
      version: 3,
      rollback_entries: '1',
      reconstructed: '100.00',
    });
  });

  it('consumes a zero BET reference once without generating ledger or changing version', async () => {
    const { rollback } = await seed('0.00');
    const before = await state(rollback.walletId);
    expect((await post(rollback)).status).toBe(200);
    expect(await state(rollback.walletId)).toEqual(before);
    const second = await post({
      ...rollback,
      externalTransactionId: crypto.randomUUID(),
    });
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_ROLLED_BACK');
  });

  it('rejects monetary overflow without consuming the BET rollback right', async () => {
    const { rollback } = await seed();
    await new SubmitWager(uow).execute(
      {
        ...rollback,
        kind: Kind.Win,
        referenceExternalTransactionId: undefined,
        externalTransactionId: crypto.randomUUID(),
        money: { amount: '999999999999999924.99', currency: 'BRL' },
      },
      crypto.randomUUID(),
    );
    const before = await state(rollback.walletId);
    const response = await post(rollback);
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await state(rollback.walletId)).toEqual(before);
    await new SubmitWager(uow).execute(
      {
        ...rollback,
        kind: Kind.Bet,
        referenceExternalTransactionId: undefined,
        externalTransactionId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
    );
    expect(
      (await post({ ...rollback, externalTransactionId: crypto.randomUUID() }))
        .status,
    ).toBe(200);
  });

  it('rolls back the credit and registration on failure and permits a clean retry', async () => {
    const { rollback } = await seed();
    const key = crypto.randomUUID();
    const before = await state(rollback.walletId);
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
      await new SubmitWager(broken).execute(rollback, key);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(await state(rollback.walletId)).toEqual(before);
    expect(
      await uow.read(({ wagers }) => wagers.findByIdempotencyKey(key)),
    ).toBeUndefined();
    expect((await post(rollback, key)).status).toBe(200);
  });

  it('conflicts if the same key changes its reference or amount', async () => {
    const { rollback } = await seed();
    const key = crypto.randomUUID();
    await post(rollback, key);
    expect(
      (
        await post(
          { ...rollback, referenceExternalTransactionId: crypto.randomUUID() },
          key,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          { ...rollback, money: { amount: '24.99', currency: 'BRL' } },
          key,
        )
      ).status,
    ).toBe(409);
  });
});
