import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import type { Response } from 'supertest';
import { WalletModule } from '../../src/interfaces/http/wallet.module.js';
import { WagerModule } from '../../src/interfaces/http/wager.module.js';
import { QueryModule } from '../../src/interfaces/http/query.module.js';
import {
  ObservabilityModule,
  CorrelationMiddleware,
  Observability,
} from '../../src/infrastructure/observability/observability.js';
import { TELEMETRY } from '../../src/application/ports/telemetry.js';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../src/application/ports/repositories.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { DependencyHealth } from '../../src/infrastructure/health/dependency-health.js';
import {
  createSqsClient,
  provisionQueues,
} from '../../src/infrastructure/messaging/sqs.js';
import { PostgreSqlReconciliationReader } from '../../src/infrastructure/persistence/reconciliation-reader.js';
import {
  SubmitWager,
  type SubmitWagerInput,
} from '../../src/application/submit-wager.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';

// Schema exclusivo: a simulação de dados legados inconsistentes nunca toca o banco da aplicação.
const schema = `query_test_${crypto.randomUUID().replaceAll('-', '')}`;
let orm: MikroORM;
let app: INestApplication;
let telemetry: Observability;
let uow: UnitOfWork;
const createWallet = async (amount = '100.00') => {
  const response = await request(app.getHttpServer())
    .post('/wallets')
    .send({
      playerId: crypto.randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    })
    .expect(201);
  return response.body as { id: string; playerId: string };
};
const bet = (wallet: { id: string; playerId: string }, amount = '10.00') => ({
  providerId: 'provider-a',
  externalTransactionId: crypto.randomUUID(),
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount, currency: 'BRL' },
});

describe('Consultas, reconciliação e observabilidade com PostgreSQL e SQS reais', () => {
  it('publica OpenAPI com dinheiro string, idempotência e estados HTTP reais', async () => {
    const response = await request(app.getHttpServer())
      .get('/openapi.json')
      .expect(200);
    expect(response.body.openapi).toBe('3.0.3');
    expect(response.body.components.schemas.Money.properties.amount.type).toBe(
      'string',
    );
    const operation = response.body.paths['/wagering/transactions'].post;
    expect(operation.parameters[0]).toMatchObject({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
    });
    expect(Object.keys(operation.responses)).toEqual([
      '200',
      '202',
      '400',
      '404',
      '409',
      '422',
      '500',
      '503',
    ]);
    expect(
      response.body.components.schemas.SubmitWager.oneOf[2].required,
    ).toContain('referenceExternalTransactionId');
  });
  beforeAll(async () => {
    orm = await MikroORM.init({
      ...createOrmConfig('dwp_test'),
      schema,
      pool: { min: 1, max: 1 },
    });
    await orm.migrator.up({ schema });
    await orm.em.fork().execute(`SET search_path TO "${schema}"`);
    const client = createSqsClient();
    try {
      await provisionQueues(client);
    } finally {
      client.destroy();
    }
    const module = await Test.createTestingModule({
      imports: [ObservabilityModule, WalletModule, WagerModule, QueryModule],
    })
      .overrideProvider(MikroORM)
      .useValue(orm)
      .compile();
    telemetry = module.get<Observability>(TELEMETRY);
    uow = module.get<UnitOfWork>(UNIT_OF_WORK);
    app = module.createNestApplication();
    const middleware = new CorrelationMiddleware(telemetry);
    app.use(middleware.use.bind(middleware));
    await app.init();
  });
  afterAll(async () => {
    // Derruba somente objetos criados por esta suíte, usando as migrations reversíveis do projeto.
    if (orm) {
      if (!/^query_test_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe test schema');
      await orm.migrator.down({ schema, to: 0 });
      await orm.em
        .fork()
        .execute(`DROP TABLE IF EXISTS "${schema}".mikro_orm_migrations`);
      await orm.em.fork().execute(`DROP SCHEMA "${schema}" RESTRICT`);
    }
    if (app) await app.close();
    else if (orm) await orm.close();
  });
  it('consulta wallet e transação por ambas as identidades, sem expor hash ou chave', async () => {
    const wallet = await createWallet();
    const body = bet(wallet);
    const submitted = await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `key:${body.externalTransactionId}`)
      .set('x-correlation-id', 'trace-test-1')
      .send(body)
      .expect(200);
    expect(submitted.headers['x-correlation-id']).toBe('trace-test-1');
    const found = await request(app.getHttpServer())
      .get(`/wagering/transactions/${submitted.body.transactionId}`)
      .expect(200);
    const external = await request(app.getHttpServer())
      .get(
        `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
      )
      .expect(200);
    expect(external.body).toEqual(found.body);
    expect(found.body).toMatchObject({
      status: 'PROCESSED',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(found.body.payloadHash).toBeUndefined();
    expect(found.body.idempotencyKey).toBeUndefined();
    const current = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}`)
      .expect(200);
    expect(current.body.balance.amount).toBe('90.00');
    expect(current.body.version).toBe(2);
    const rows = await orm.em
      .fork()
      .execute('SELECT correlation_id FROM wager_transactions WHERE id = ?', [
        submitted.body.transactionId,
      ]);
    expect(rows[0].correlation_id).toBe('trace-test-1');
    await request(app.getHttpServer())
      .get(
        `/providers/another-provider/wagering/transactions/${body.externalTransactionId}`,
      )
      .expect(404);
  });
  it('paginação opaca percorre lançamentos sem repetir nem omitir IDs', async () => {
    const wallet = await createWallet();
    for (let index = 0; index < 4; index++) {
      const body = bet(wallet);
      await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('idempotency-key', `key:${body.externalTransactionId}`)
        .send(body)
        .expect(200);
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Response = await request(app.getHttpServer())
        .get(`/wallets/${wallet.id}/ledger`)
        .query({ limit: '2', ...(cursor ? { cursor } : {}) })
        .expect(200);
      expect(page.body.entries.length).toBeLessThanOrEqual(2);
      for (const entry of page.body.entries) {
        expect(entry.money.amount).toMatch(/^\d+\.\d{2}$/);
        expect(entry.balanceAfter.currency).toBe('BRL');
        ids.push(entry.id);
      }
      cursor = page.body.nextCursor;
      if (cursor) expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    } while (cursor);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    const all = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}/ledger`)
      .expect(200);
    expect(ids).toEqual(
      all.body.entries.map((entry: { id: string }) => entry.id),
    );
  });
  it('cursor não pode ser reutilizado em outra wallet e limite máximo é 100', async () => {
    const first = await createWallet();
    const second = await createWallet();
    const body = bet(first);
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `key:${body.externalTransactionId}`)
      .send(body)
      .expect(200);
    const page = await request(app.getHttpServer())
      .get(`/wallets/${first.id}/ledger?limit=1`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/wallets/${second.id}/ledger`)
      .query({ cursor: page.body.nextCursor })
      .expect(400);
    for (const limit of ['0', '101', '-1', '1.5', '', '1e2', '01'])
      await request(app.getHttpServer())
        .get(`/wallets/${first.id}/ledger`)
        .query({ limit })
        .expect(400);
    await request(app.getHttpServer())
      .get(`/wallets/${first.id}/ledger?limit=100`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/wallets/${first.id}/ledger?cursor=garbage`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/wallets/${first.id}/ledger?limit=1&limit=2`)
      .expect(400);
  });
  it('404 para identidade inexistente e 400 para UUID inválido', async () => {
    await request(app.getHttpServer())
      .get(`/wallets/${crypto.randomUUID()}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/wallets/${crypto.randomUUID()}/ledger`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/wagering/transactions/${crypto.randomUUID()}`)
      .expect(404);
    await request(app.getHttpServer()).get('/wallets/not-a-uuid').expect(400);
    await request(app.getHttpServer())
      .post(`/wallets/${crypto.randomUUID()}/reconciliation`)
      .expect(404);
  });
  it('reconcilia saldo zero sem opening e saldo movimentado com histórico completo', async () => {
    const empty = await createWallet('0.00');
    const zero = await request(app.getHttpServer())
      .post(`/wallets/${empty.id}/reconciliation`)
      .expect(200);
    expect(zero.body).toMatchObject({
      checkedEntries: 0,
      consistent: true,
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
    });
    const funded = await createWallet();
    const body = bet(funded);
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('idempotency-key', `key:${body.externalTransactionId}`)
      .send(body)
      .expect(200);
    const checked = await request(app.getHttpServer())
      .post(`/wallets/${funded.id}/reconciliation`)
      .expect(200);
    expect(checked.body).toMatchObject({
      checkedEntries: 2,
      consistent: true,
      storedBalance: { amount: '90.00' },
      calculatedBalance: { amount: '90.00' },
    });
  });
  it('reconciliação não mistura saldo antigo com ledger novo durante transação não confirmada', async () => {
    const wallet = await createWallet();
    // A segunda conexão consulta somente estado confirmado; não espera pelo lock da wallet.
    const readerOrm = await MikroORM.init({
      ...createOrmConfig('dwp_test'),
      // Separa o contexto assíncrono do writer: são duas aplicações/conexões independentes.
      contextName: `${schema}_reader`,
      schema,
      pool: { min: 1, max: 1 },
    });
    try {
      await readerOrm.em.fork().execute(`SET search_path TO "${schema}"`);
      await uow.transaction(async (session) => {
        await new SubmitWager(uow).executeInTransaction(
          session,
          bet(wallet) as SubmitWagerInput,
          crypto.randomUUID(),
        );
        // Um leitor consistente continua vendo o último commit mesmo quando a writer mantém o lock.
        const snapshot = await new PostgreSqlReconciliationReader(
          readerOrm,
        ).snapshot(wallet.id);
        expect(snapshot?.storedBalance.amount).toBe('100.00');
        expect(snapshot?.calculatedBalance.amount).toBe('100.00');
        expect(snapshot?.checkedEntries).toBe(1);
      });
      const committed = await new PostgreSqlReconciliationReader(
        readerOrm,
      ).snapshot(wallet.id);
      expect(committed?.storedBalance.amount).toBe('90.00');
      expect(committed?.calculatedBalance.amount).toBe('90.00');
      expect(committed?.checkedEntries).toBe(2);
    } finally {
      await readerOrm.close();
    }
  });
  it('timeout de lock real incrementa a métrica sem alterar o saldo', async () => {
    const wallet = await createWallet();
    const contender = await MikroORM.init({
      ...createOrmConfig('dwp_test'),
      schema,
      contextName: `${schema}_contender`,
      pool: { min: 1, max: 1 },
    });
    try {
      await contender.em.fork().execute(`SET search_path TO "${schema}"`);
      await contender.em.fork().execute("SET lock_timeout = '100ms'");
      const competingUow = new PostgreSqlUnitOfWork(contender, telemetry);
      await uow.transaction(async (session) => {
        await session.wallets.findByIdForUpdate(wallet.id);
        const error = await competingUow
          .transaction(({ wallets }) => wallets.findByIdForUpdate(wallet.id))
          .catch((error: unknown) => error);
        expect(error).toMatchObject({ code: '55P03' });
      });
      expect(telemetry.metrics(0)).toContain('dwp_lock_conflicts_total 1');
      const current = await request(app.getHttpServer())
        .get(`/wallets/${wallet.id}`)
        .expect(200);
      expect(current.body.balance.amount).toBe('100.00');
    } finally {
      await contender.close();
    }
  });
  it('health responde com pool ocupado e se recupera sem acumular sondagens', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocker = uow.transaction(async () => {
      entered();
      await held;
    });
    await acquired;
    const health = new DependencyHealth(orm);
    try {
      const started = performance.now();
      const checks = await Promise.all([health.ready(), health.ready()]);
      expect(checks).toEqual([
        { postgres: false, sqs: true },
        { postgres: false, sqs: true },
      ]);
      expect(performance.now() - started).toBeLessThan(4500);
    } finally {
      release();
      await blocker;
      health.onApplicationShutdown();
    }
  });
  it('detecta divergência legada, incrementa métrica e não corrige wallet ou ledger', async () => {
    const wallet = await createWallet();
    // Exclusivamente no schema descartável: simula corrupção anterior às proteções atuais.
    await orm.em.fork().transactional(async (em) => {
      await em.execute('ALTER TABLE wallets DISABLE TRIGGER USER');
      await em.execute('UPDATE wallets SET balance = 101.00 WHERE id = ?', [
        wallet.id,
      ]);
      await em.execute('ALTER TABLE wallets ENABLE TRIGGER USER');
    });
    const checked = await request(app.getHttpServer())
      .post(`/wallets/${wallet.id}/reconciliation`)
      .expect(200);
    expect(checked.body).toMatchObject({
      consistent: false,
      checkedEntries: 1,
      storedBalance: { amount: '101.00' },
      calculatedBalance: { amount: '100.00' },
      difference: { amount: '1.00' },
    });
    const current = await request(app.getHttpServer())
      .get(`/wallets/${wallet.id}`)
      .expect(200);
    expect(current.body.balance.amount).toBe('101.00');
    const metrics = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    expect(metrics.text).toContain('dwp_reconciliation_divergences_total 1');
  });
  it('métricas ignoram observações de transações com rollback e contam replays após commit', async () => {
    const before = telemetry.metrics(0);
    const failure = await uow
      .transaction(async (session) => {
        session.recordAfterCommit?.({ type: 'transaction', status: 'FAILED' });
        throw new Error('forced rollback');
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(telemetry.metrics(0)).not.toContain('status="FAILED"');
    expect(before).not.toContain('status="FAILED"');
    const wallet = await createWallet();
    const body = bet(wallet);
    for (let index = 0; index < 2; index++)
      await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('idempotency-key', `key:${body.externalTransactionId}`)
        .send(body)
        .expect(200);
    const metrics = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.text).toContain(
      'dwp_duplicates_total{source="idempotency"} 1',
    );
    expect(metrics.text).toContain(
      'dwp_processing_duration_seconds_bucket{source="sql",le="+Inf"}',
    );
    expect(metrics.text).toContain('dwp_outbox_lag_seconds ');
    expect(metrics.text).not.toContain(wallet.id);
  });
  it('health verifica os serviços reais sem exigir autenticação', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'up' });
    const ready = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(ready.body.checks).toEqual({ postgres: true, sqs: true });
  });
  it('SQS indisponível causa readiness down e não impede liveness', async () => {
    const previous = process.env.SQS_ENDPOINT;
    process.env.SQS_ENDPOINT = 'http://127.0.0.1:1';
    const health = new DependencyHealth(orm);
    if (previous === undefined) delete process.env.SQS_ENDPOINT;
    else process.env.SQS_ENDPOINT = previous;
    try {
      expect(await health.ready()).toEqual({ postgres: true, sqs: false });
    } finally {
      health.onApplicationShutdown();
    }
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});
