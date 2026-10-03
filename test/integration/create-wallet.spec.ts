import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import { WalletModule } from '../../src/interfaces/http/wallet.module.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import {
  UNIT_OF_WORK,
  type RepositorySession,
  type UnitOfWork,
} from '../../src/application/ports/repositories.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';

const connect = () => MikroORM.init(createOrmConfig('dwp_test'));
let orm: Awaited<ReturnType<typeof connect>>;
let app: INestApplication;
const input = (amount = '100.00', playerId = crypto.randomUUID()) => ({
  playerId,
  initialBalance: { amount, currency: 'BRL' },
});
const post = (body: unknown) =>
  request(app.getHttpServer())
    .post('/wallets')
    .send(body as object);

// HTTP real do NestJS + repositories reais + PostgreSQL, com IDs exclusivos por teste.
describe('POST /wallets', () => {
  beforeAll(async () => {
    orm = await connect();
    await orm.migrator.up();
    const module = await Test.createTestingModule({ imports: [WalletModule] })
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

  // Não basta receber 201: verificamos os três registros confirmados no banco.
  it('creates a funded wallet with one internal opening and one balanced credit', async () => {
    const body = input('1000.00');
    const response = await post(body);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      playerId: body.playerId,
      balance: body.initialBalance,
      version: 1,
    });
    const rows = await orm.em.fork().execute(
      `SELECT w.balance, w.version, t.kind, t.status, t.observed_balance,
      t.provider_id, e.direction, e.amount, e.balance_before, e.balance_after
      FROM wallets w JOIN wager_transactions t ON t.wallet_id = w.id
      JOIN wallet_ledger_entries e ON e.transaction_id = t.id WHERE w.id = ?`,
      [response.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      balance: '1000.00',
      version: 1,
      kind: 'OPENING',
      status: 'PROCESSED',
      observed_balance: '1000.00',
      provider_id: '__internal__',
      direction: 'CREDIT',
      amount: '1000.00',
      balance_before: '0.00',
      balance_after: '1000.00',
    });
  });

  it('creates zero balance without an opening transaction or ledger', async () => {
    const response = await post(input('0.00'));
    expect(response.status).toBe(201);
    expect(response.body.balance.amount).toBe('0.00');
    const rows = await orm.em.fork().execute(
      `SELECT
      (SELECT count(*) FROM wager_transactions WHERE wallet_id = ?) AS transactions,
      (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = ?) AS entries`,
      [response.body.id, response.body.id],
    );
    expect(rows[0]).toEqual({ transactions: '0', entries: '0' });
  });

  it('rejects a duplicate player/currency without changing the original balance', async () => {
    const body = input();
    const original = await post(body);
    const duplicate = await post({
      ...body,
      initialBalance: { amount: '999.00', currency: 'BRL' },
    });
    expect(original.status).toBe(201);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('WALLET_ALREADY_EXISTS');
    expect(
      (
        await orm.em
          .fork()
          .execute('SELECT balance FROM wallets WHERE id = ?', [
            original.body.id,
          ])
      )[0].balance,
    ).toBe('100.00');
  });

  // Requisições concorrentes não podem gerar duas aberturas para a mesma wallet.
  it('creates only one wallet under parallel duplicate requests', async () => {
    const body = input();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post(body)),
    );
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 409),
    ).toHaveLength(9);
    const rows = await orm.em.fork().execute(
      `SELECT
      (SELECT count(*) FROM wallets WHERE player_id = ?) AS wallets,
      (SELECT count(*) FROM wager_transactions WHERE player_id = ?) AS transactions,
      (SELECT count(*) FROM wallet_ledger_entries e JOIN wallets w ON w.id = e.wallet_id WHERE w.player_id = ?) AS entries`,
      [body.playerId, body.playerId, body.playerId],
    );
    expect(rows[0]).toEqual({ wallets: '1', transactions: '1', entries: '1' });
  });

  it('permits a different currency for the same player and normalizes UUID case', async () => {
    const body = input('1.00');
    const first = await post(body);
    const second = await post({
      playerId: body.playerId.toUpperCase(),
      initialBalance: { amount: '1.00', currency: 'USD' },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.playerId).toBe(body.playerId);
    expect(second.body.balance.currency).toBe('USD');
  });

  it('preserves cents at the monetary capacity boundary', async () => {
    const response = await post(input('999999999999999999.99'));
    expect(response.status).toBe(201);
    expect(response.body.balance.amount).toBe('999999999999999999.99');
  });

  const malformedBodies: unknown[] = [
    // O contrato inválido é unknown porque representa dados externos sem validação.
    {
      playerId: 'invalid',
      initialBalance: { amount: '1.00', currency: 'BRL' },
    },
    { initialBalance: { amount: '1.00', currency: 'BRL' } },
    { playerId: crypto.randomUUID() },
    { ...input(), initialBalance: { amount: 1, currency: 'BRL' } },
    { ...input(), initialBalance: null },
    { ...input(), kind: 'OPENING' },
    {
      ...input(),
      initialBalance: { amount: '1.00', currency: 'BRL', extra: true },
    },
  ];

  it.each([
    '-1.00',
    '1.001',
    '1e3',
    'NaN',
    'Infinity',
    '1',
    '1.0',
    '1000000000000000000.00',
  ])('rejects invalid Money %s before any write', async (amount) => {
    const body = input(amount);
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_MONEY');
    expect(
      (
        await orm.em
          .fork()
          .execute('SELECT id FROM wallets WHERE player_id = ?', [
            body.playerId,
          ])
      ).length,
    ).toBe(0);
  });

  it.each(malformedBodies.map((body) => ({ body })))(
    'rejects malformed contracts and unknown fields',
    async ({ body }) => {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_PAYLOAD');
    },
  );

  it('rejects unknown currency codes', async () => {
    const response = await post({
      ...input(),
      initialBalance: { amount: '1.00', currency: 'ZZZ' },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_MONEY');
  });

  // Injeta falha somente no último INSERT; as gravações anteriores usam PostgreSQL real.
  it('rolls back wallet and opening when ledger insertion fails', async () => {
    const failureOrm = await connect();
    const realUnitOfWork = new PostgreSqlUnitOfWork(failureOrm);
    const failingUnitOfWork: UnitOfWork = {
      read: (operation) => realUnitOfWork.read(operation),
      transaction: (operation) =>
        realUnitOfWork.transaction((session: RepositorySession) =>
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
    const module = await Test.createTestingModule({ imports: [WalletModule] })
      .overrideProvider(MikroORM)
      .useValue(failureOrm)
      .overrideProvider(UNIT_OF_WORK)
      .useValue(failingUnitOfWork)
      .compile();
    const failedApp = module.createNestApplication();
    await failedApp.init();
    const body = input();
    try {
      const response = await request(failedApp.getHttpServer())
        .post('/wallets')
        .send(body);
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('Injected');
      const rows = await orm.em.fork().execute(
        `SELECT
        (SELECT count(*) FROM wallets WHERE player_id = ?) AS wallets,
        (SELECT count(*) FROM wager_transactions WHERE player_id = ?) AS transactions`,
        [body.playerId, body.playerId],
      );
      expect(rows[0]).toEqual({ wallets: '0', transactions: '0' });
    } finally {
      // Fecha também o pool exclusivo desta aplicação de teste.
      await failedApp.close();
    }
  });
});
