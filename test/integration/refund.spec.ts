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
import { ProcessRefund } from '../../src/application/process-refund.js';
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
    providerId: 'refund-tests',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: { amount, currency: 'BRL' },
  };
  const result = await new SubmitWager(uow).execute(bet, crypto.randomUUID());
  const refund: SubmitWagerInput = {
    ...bet,
    externalTransactionId: crypto.randomUUID(),
    kind: Kind.Refund,
    referenceExternalTransactionId: bet.externalTransactionId,
  };
  return { bet, result, refund };
}
async function state(walletId: string) {
  const [row] = await orm.em.fork().execute(
    `SELECT balance, version, updated_at::text AS updated_at,
    (SELECT count(*) FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id WHERE e.wallet_id = w.id AND t.kind = 'REFUND') AS refund_entries,
    (SELECT sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries WHERE wallet_id = w.id)::numeric(20,2)::text AS reconstructed
    FROM wallets w WHERE id = ?`,
    [walletId],
  );
  return row;
}

// Todos os efeitos financeiros são verificados no PostgreSQL, com reconciliação pelo ledger.
describe('REFUND through HTTP and PostgreSQL', () => {
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

  it('refunds a processed BET exactly once and links one CREDIT to its reference', async () => {
    const { refund, result } = await seed();
    const response = await post(refund);
    expect(response.status).toBe(200);
    expect(response.body.balance.amount).toBe('100.00');
    expect(await state(refund.walletId)).toMatchObject({
      balance: '100.00',
      version: 3,
      refund_entries: '1',
      reconstructed: '100.00',
    });
    const tx = await uow.read(({ wagers }) =>
      wagers.findById(response.body.transactionId),
    );
    expect(tx?.status).toBe(Status.Processed);
    expect(tx?.referenceTransactionId).toBe(result.transactionId);
    const entry = await uow.read(({ ledger }) =>
      ledger.findByTransaction(refund.walletId, response.body.transactionId),
    );
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.money.toString()).toBe('25.00');
    expect(entry?.balanceBefore.toString()).toBe('75.00');
    expect(entry?.balanceAfter.toString()).toBe('100.00');
  });

  it('replays the original result but rejects another REFUND of the same BET', async () => {
    const { refund } = await seed();
    const key = crypto.randomUUID();
    const original = await post(refund, key);
    const before = await state(refund.walletId);
    const second = await post({
      ...refund,
      externalTransactionId: crypto.randomUUID(),
    });
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REFUNDED');
    expect(await state(refund.walletId)).toEqual(before);
    await new SubmitWager(uow).execute(
      {
        ...refund,
        referenceExternalTransactionId: undefined,
        kind: Kind.Bet,
        externalTransactionId: crypto.randomUUID(),
        money: { amount: '10.00', currency: 'BRL' },
      },
      crypto.randomUUID(),
    );
    const replay = await post(refund, key);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe('100.00');
    expect((await state(refund.walletId)).balance).toBe('90.00');
  });

  it.each(['amount', 'round', 'kind', 'rejected-bet', 'player', 'wallet'])(
    'rejects invalid reference %s without changing wallet or ledger',
    async (scenario) => {
      const { refund } = await seed(
        scenario === 'rejected-bet' ? '1000.00' : '25.00',
      );
      let payload = refund;
      if (scenario === 'amount')
        payload = { ...refund, money: { amount: '24.99', currency: 'BRL' } };
      if (scenario === 'round')
        payload = { ...refund, roundId: 'another-round' };
      if (scenario === 'kind') {
        const win: SubmitWagerInput = {
          ...refund,
          kind: Kind.Win,
          referenceExternalTransactionId: undefined,
          externalTransactionId: crypto.randomUUID(),
        };
        await new SubmitWager(uow).execute(win, crypto.randomUUID());
        payload = {
          ...refund,
          referenceExternalTransactionId: win.externalTransactionId,
        };
      }
      if (scenario === 'player' || scenario === 'wallet') {
        const wallet = await new CreateWallet(uow).execute({
          playerId:
            scenario === 'wallet' ? refund.playerId : crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'USD' },
        });
        const otherBet: SubmitWagerInput = {
          ...refund,
          kind: Kind.Bet,
          referenceExternalTransactionId: undefined,
          externalTransactionId: crypto.randomUUID(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: { amount: '25.00', currency: 'USD' },
        };
        await new SubmitWager(uow).execute(otherBet, crypto.randomUUID());
        payload = {
          ...refund,
          referenceExternalTransactionId: otherBet.externalTransactionId,
        };
      }
      const before = await state(refund.walletId);
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
      expect(await state(refund.walletId)).toEqual(before);
      // Uma tentativa rejeitada por valor errado não consome o direito de devolver a BET.
      if (scenario === 'amount')
        expect(
          (
            await post({
              ...refund,
              externalTransactionId: crypto.randomUUID(),
            })
          ).status,
        ).toBe(200);
    },
  );

  it.each(['provider', 'currency'])(
    'defends reference %s even if an adapter returns incompatible data',
    async (field) => {
      const { refund, bet, result } = await seed();
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
      const before = await state(refund.walletId);
      const outcome = await new SubmitWager(guarded).execute(
        refund,
        crypto.randomUUID(),
      );
      expect(outcome.status).toBe(Status.Rejected);
      expect(outcome.failureCode).toBe(
        field === 'provider'
          ? FailureCode.ProviderMismatch
          : FailureCode.CurrencyMismatch,
      );
      expect(await state(refund.walletId)).toEqual(before);
    },
  );

  it('requires a non-empty reference and rejects self reference before registration', async () => {
    const { refund } = await seed();
    const before = await state(refund.walletId);
    for (const reference of [undefined, '', refund.externalTransactionId]) {
      const key = crypto.randomUUID();
      expect(
        (
          await post(
            { ...refund, referenceExternalTransactionId: reference },
            key,
          )
        ).status,
      ).toBe(400);
      expect(
        await uow.read(({ wagers }) => wagers.findByIdempotencyKey(key)),
      ).toBeUndefined();
    }
    expect(await state(refund.walletId)).toEqual(before);
  });

  it('waits for a missing BET and processes the REFUND only after it arrives', async () => {
    const { refund } = await seed();
    const external = crypto.randomUUID();
    const payload = { ...refund, referenceExternalTransactionId: external };
    const response = await post(payload);
    const before = await state(refund.walletId);
    expect(response.status).toBe(202);
    expect(response.body.status).toBe('PENDING_REFERENCE');
    expect(before.refund_entries).toBe('0');
    await new SubmitWager(uow).execute(
      {
        ...refund,
        kind: Kind.Bet,
        referenceExternalTransactionId: undefined,
        externalTransactionId: external,
      },
      crypto.randomUUID(),
    );
    await new ProcessRefund(uow).execute(response.body.transactionId);
    expect(await state(refund.walletId)).toMatchObject({
      balance: '75.00',
      version: 4,
      refund_entries: '1',
      reconstructed: '75.00',
    });
  });

  it('waits for an existing pending BET rather than refunding before its debit', async () => {
    const { refund } = await seed();
    const id = crypto.randomUUID();
    const pending = WagerTransaction.create({
      ...refund,
      referenceExternalTransactionId: undefined,
      id,
      kind: Kind.Bet,
      externalTransactionId: id,
      idempotencyKey: `pending:${id}`,
      payloadHash: 'a'.repeat(64),
      money: Money.from(refund.money),
      createdAt: new Date(),
    });
    await uow.transaction(({ wagers }) => wagers.create(pending));
    const response = await post({
      ...refund,
      referenceExternalTransactionId: id,
    });
    expect(response.status).toBe(202);
    await new ProcessBet(uow).execute(id);
    await new ProcessRefund(uow).execute(response.body.transactionId);
    expect((await state(refund.walletId)).balance).toBe('75.00');
  });

  it('does not resolve a BET from another provider', async () => {
    const { refund } = await seed();
    const before = await state(refund.walletId);
    const response = await post({ ...refund, providerId: 'another-provider' });
    expect(response.status).toBe(202);
    expect(await state(refund.walletId)).toEqual(before);
  });

  it('handles 50 duplicate refunds with one credit and 49 replays', async () => {
    const { refund } = await seed();
    const key = crypto.randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => post(refund, key)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      responses.filter((response) => response.body.idempotentReplay === false),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.body.idempotentReplay === true),
    ).toHaveLength(49);
    expect(await state(refund.walletId)).toMatchObject({
      balance: '100.00',
      version: 3,
      refund_entries: '1',
      reconstructed: '100.00',
    });
  });

  it('allows one winner among different concurrent REFUND operations of the same BET', async () => {
    const { refund } = await seed();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post({ ...refund, externalTransactionId: crypto.randomUUID() }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(
      responses.filter(
        (response) =>
          response.status === 422 &&
          response.body.failureCode === 'REFERENCE_ALREADY_REFUNDED',
      ),
    ).toHaveLength(9);
    expect(await state(refund.walletId)).toMatchObject({
      balance: '100.00',
      version: 3,
      refund_entries: '1',
      reconstructed: '100.00',
    });
  });

  it('consumes a zero BET reference once without generating ledger or changing version', async () => {
    const { refund } = await seed('0.00');
    const before = await state(refund.walletId);
    expect((await post(refund)).status).toBe(200);
    expect(await state(refund.walletId)).toEqual(before);
    const second = await post({
      ...refund,
      externalTransactionId: crypto.randomUUID(),
    });
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REFUNDED');
  });

  it('rejects monetary overflow without consuming the BET refund right', async () => {
    const { refund } = await seed();
    await new SubmitWager(uow).execute(
      {
        ...refund,
        kind: Kind.Win,
        referenceExternalTransactionId: undefined,
        externalTransactionId: crypto.randomUUID(),
        money: { amount: '999999999999999924.99', currency: 'BRL' },
      },
      crypto.randomUUID(),
    );
    const before = await state(refund.walletId);
    const response = await post(refund);
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await state(refund.walletId)).toEqual(before);
    await new SubmitWager(uow).execute(
      {
        ...refund,
        kind: Kind.Bet,
        referenceExternalTransactionId: undefined,
        externalTransactionId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
    );
    expect(
      (await post({ ...refund, externalTransactionId: crypto.randomUUID() }))
        .status,
    ).toBe(200);
  });

  it('rolls back the credit and registration on failure and permits a clean retry', async () => {
    const { refund } = await seed();
    const key = crypto.randomUUID();
    const before = await state(refund.walletId);
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
      await new SubmitWager(broken).execute(refund, key);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(await state(refund.walletId)).toEqual(before);
    expect(
      await uow.read(({ wagers }) => wagers.findByIdempotencyKey(key)),
    ).toBeUndefined();
    expect((await post(refund, key)).status).toBe(200);
  });

  it('conflicts if the same key changes its reference or amount', async () => {
    const { refund } = await seed();
    const key = crypto.randomUUID();
    await post(refund, key);
    expect(
      (
        await post(
          { ...refund, referenceExternalTransactionId: crypto.randomUUID() },
          key,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          { ...refund, money: { amount: '24.99', currency: 'BRL' } },
          key,
        )
      ).status,
    ).toBe(409);
  });
});
