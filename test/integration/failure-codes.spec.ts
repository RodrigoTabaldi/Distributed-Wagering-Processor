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
import { Money } from '../../src/domain/money.js';
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
async function payload(
  kind: SubmitWagerInput['kind'] = Kind.Bet,
): Promise<SubmitWagerInput> {
  const wallet = await new CreateWallet(uow).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '0.00', currency: 'BRL' },
  });
  return {
    providerId: 'failure-codes',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: { amount: '10.00', currency: 'BRL' },
  };
}
const post = (body: SubmitWagerInput, key = crypto.randomUUID()) =>
  request(app.getHttpServer())
    .post('/wagering/transactions')
    .set('Idempotency-Key', key)
    .send(body);
async function stored(id: string) {
  const [row] = await orm.em
    .fork()
    .execute('SELECT * FROM wager_transactions WHERE id = ?', [id]);
  return row;
}

// Verifica o contrato em três fronteiras: domínio, coluna PostgreSQL e resposta HTTP/replay.
describe('Failure codes persisted and exposed', () => {
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

  it('returns the persisted BET rejection code unchanged after balance changes', async () => {
    const input = await payload();
    const key = crypto.randomUUID();
    const original = await post(input, key);
    expect(original.status).toBe(422);
    expect(original.body.failureCode).toBe('INSUFFICIENT_BALANCE');
    const before = await stored(original.body.transactionId);
    expect(before.failure_code).toBe('INSUFFICIENT_BALANCE');
    await new SubmitWager(uow).execute(
      { ...input, kind: Kind.Win, externalTransactionId: crypto.randomUUID() },
      crypto.randomUUID(),
    );
    const replay = await post(input, key);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(await stored(original.body.transactionId)).toEqual(before);
    const tx = await uow.read(({ wagers }) =>
      wagers.findById(original.body.transactionId),
    );
    expect(tx?.failureCode).toBe(FailureCode.InsufficientBalance);
  });

  it('persists the distinct rollback code without creating a reversal ledger', async () => {
    const input = await payload(Kind.Win);
    const win = await post(input);
    await post({
      ...input,
      kind: Kind.Bet,
      externalTransactionId: crypto.randomUUID(),
    });
    const response = await post({
      ...input,
      kind: Kind.Rollback,
      externalTransactionId: crypto.randomUUID(),
      referenceExternalTransactionId: input.externalTransactionId,
    });
    expect(win.status).toBe(200);
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('REVERSAL_INSUFFICIENT_BALANCE');
    expect((await stored(response.body.transactionId)).failure_code).toBe(
      'REVERSAL_INSUFFICIENT_BALANCE',
    );
    expect(
      await uow.read(({ ledger }) =>
        ledger.findByTransaction(input.walletId, response.body.transactionId),
      ),
    ).toBeUndefined();
  });

  it('returns an idempotency conflict without replacing the original transaction failureCode', async () => {
    const input = await payload();
    const key = crypto.randomUUID();
    const original = await post(input, key);
    const before = await stored(original.body.transactionId);
    const conflict = await post(
      { ...input, money: { amount: '20.00', currency: 'BRL' } },
      key,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await stored(original.body.transactionId)).toEqual(before);
    // O conflito é da nova requisição: não reescreve o resultado financeiro original.
    expect(before.failure_code).toBe('INSUFFICIENT_BALANCE');
  });

  it('keeps an absent reference pending without prematurely recording REFERENCE_NOT_FOUND', async () => {
    const input = await payload(Kind.Refund);
    const response = await post({
      ...input,
      referenceExternalTransactionId: crypto.randomUUID(),
    });
    expect(response.status).toBe(202);
    expect(response.body.failureCode).toBeUndefined();
    const row = await stored(response.body.transactionId);
    expect(row.status).toBe('PENDING_REFERENCE');
    expect(row.failure_code).toBeNull();
  });

  it.each([
    FailureCode.ReferenceNotFound,
    FailureCode.PermanentInfrastructureFailure,
  ])(
    'round-trips terminal code %s without executing its future retry policy',
    async (code) => {
      const input = await payload(
        code === FailureCode.ReferenceNotFound ? Kind.Refund : Kind.Bet,
      );
      const id = crypto.randomUUID();
      const tx = WagerTransaction.create({
        ...input,
        id,
        idempotencyKey: id,
        payloadHash: 'a'.repeat(64),
        money: Money.from(input.money),
        createdAt: new Date(),
        ...(code === FailureCode.ReferenceNotFound
          ? { referenceExternalTransactionId: crypto.randomUUID() }
          : {}),
      });
      // Simula apenas a decisão terminal futura. Worker, TTL e retry NÃO são implementados neste teste.
      if (code === FailureCode.ReferenceNotFound) tx.markPendingReference();
      const expectedStatus = tx.status;
      await uow.transaction(({ wagers }) => wagers.create(tx));
      if (code === FailureCode.ReferenceNotFound) tx.reject(code);
      else tx.fail(code);
      await uow.transaction(({ wagers }) =>
        wagers.updateState(tx, expectedStatus, new Date(), Money.zero('BRL')),
      );
      const loaded = await uow.read(({ wagers }) => wagers.findById(id));
      expect(loaded?.failureCode).toBe(code);
      expect(loaded?.status).toBe(
        code === FailureCode.ReferenceNotFound
          ? Status.Rejected
          : Status.Failed,
      );
      expect((await stored(id)).failure_code).toBe(code);
      expect(
        await uow.read(({ ledger }) =>
          ledger.findByTransaction(input.walletId, id),
        ),
      ).toBeUndefined();
    },
  );
});
