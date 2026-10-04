import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { createOrmConfig } from '../src/infrastructure/persistence/orm.config.js';
import { WalletModule } from '../src/interfaces/http/wallet.module.js';
import { WagerModule } from '../src/interfaces/http/wager.module.js';
import { QueryModule } from '../src/interfaces/http/query.module.js';
import { AuthModule } from '../src/interfaces/http/auth.module.js';
import {
  ObservabilityModule,
  Observability,
  CorrelationMiddleware,
} from '../src/infrastructure/observability/observability.js';
import { TELEMETRY } from '../src/application/ports/telemetry.js';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../src/application/ports/repositories.js';
import { PublishOutbox } from '../src/application/publish-outbox.js';
import {
  createSqsClient,
  provisionQueues,
  SqsTransport,
  type QueueUrls,
} from '../src/infrastructure/messaging/sqs.js';
import { assertFinancialConsistency } from './helpers/financial-consistency.js';

// Carga real HTTP → aplicação → PostgreSQL → Outbox → SQS. Nunca grava nas wallets de desenvolvimento.
const count = Number(process.env.LOAD_REQUESTS ?? '100');
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? '8');
const historyEntries = Number(process.env.LOAD_HISTORY_ENTRIES ?? '0');
const publishDelayMs = Number(process.env.LOAD_SQS_DELAY_MS ?? '0');
const drainTimeoutMs = Number(process.env.LOAD_DRAIN_TIMEOUT_MS ?? '60000');
if (
  !Number.isInteger(historyEntries) ||
  historyEntries < 0 ||
  historyEntries > 5000 ||
  !Number.isInteger(publishDelayMs) ||
  publishDelayMs < 0 ||
  publishDelayMs > 1000 ||
  !Number.isInteger(drainTimeoutMs) ||
  drainTimeoutMs < 1000 ||
  drainTimeoutMs > 300000
)
  throw new Error('Invalid load history, SQS delay or drain timeout');
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 5000 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 64
)
  throw new Error('LOAD_REQUESTS: 1..5000; LOAD_CONCURRENCY: 1..64');
const schema = `load_test_${crypto.randomUUID().replaceAll('-', '')}`;
if (!/^load_test_[a-f0-9]{32}$/.test(schema))
  throw new Error('Unsafe load schema');
const client = createSqsClient();
let orm: MikroORM | undefined;
let app: INestApplication | undefined;
let urls: QueueUrls | undefined;
let running = true;
let publisherTask: Promise<void> | undefined;
let maxLag = 0;
let finalLag = 0;
let publisherFailure: unknown;
let poolSampler: ReturnType<typeof setInterval> | undefined;
let poolSamples = 0;
let busyConnectionSamples = 0;
let maxBusyConnections = 0;
let maxWaitingRequests = 0;
const records: object[] = [];

try {
  // driverOptions.options configura search_path em TODAS as oito conexões, não só na primeira.
  orm = await MikroORM.init({
    ...createOrmConfig('dwp_test'),
    schema,
    pool: { min: 1, max: 8 },
    driverOptions: { options: `-c search_path=${schema}` },
  });
  await orm.migrator.up({ schema });
  urls = await provisionQueues(client, `${schema}-`);
  Logger.overrideLogger(['error', 'warn']);
  const module = await Test.createTestingModule({
    imports: [
      ObservabilityModule,
      AuthModule,
      WalletModule,
      WagerModule,
      QueryModule,
    ],
  })
    .overrideProvider(MikroORM)
    .useValue(orm)
    .compile();
  app = module.createNestApplication({ logger: false });
  const telemetry = module.get<Observability>(TELEMETRY);
  const middleware = new CorrelationMiddleware(telemetry);
  app.use(middleware.use.bind(middleware));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const post = async (path: string, payload: object, key?: string) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify(payload),
    });
    const data: unknown = await response.json();
    return { status: response.status, data };
  };
  const wallets: { id: string; playerId: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const opened = await post('/wallets', {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '10000.00', currency: 'BRL' },
    });
    if (opened.status !== 201)
      throw new Error('Load fixture could not create wallet');
    wallets.push(opened.data as { id: string; playerId: string });
  }
  const bet = (index: number) => ({
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    walletId: wallets[index]!.id,
    playerId: wallets[index]!.playerId,
    roundId: 'load-round',
    gameId: 'load-game',
    kind: 'BET',
    money: { amount: '0.10', currency: 'BRL' },
  });
  // Aquecimento fica fora dos percentis e do throughput; suas gravações entram na auditoria final.
  for (let i = 0; i < 20; i++) {
    if (
      (
        await post(
          '/wagering/transactions',
          bet(i % wallets.length),
          crypto.randomUUID(),
        )
      ).status !== 200
    )
      throw new Error('Warmup failed');
  }
  const publisher = new PublishOutbox(module.get<UnitOfWork>(UNIT_OF_WORK), {
    publish: async (message, signal) => {
      // Atraso controlado antes do envio real simula rede lenta sem substituir o SQS.
      if (publishDelayMs) await delay(publishDelayMs, undefined, { signal });
      await new SqsTransport(client, urls!).publish(message, signal);
    },
  });
  const pool = await orm.em.getConnection().getNativeClient();
  poolSampler = setInterval(() => {
    // Consultar o pool local não executa SQL nem disputa uma conexão com o experimento.
    const busy = pool.totalCount - pool.idleCount;
    poolSamples++;
    busyConnectionSamples += busy;
    maxBusyConnections = Math.max(maxBusyConnections, busy);
    maxWaitingRequests = Math.max(maxWaitingRequests, pool.waitingCount);
  }, 10);
  const sampleLag = async () => {
    const [row] = await orm!.em
      .fork()
      .execute<{ lag: string }[]>(
        `SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(occurred_at)), 0)::text AS lag FROM outbox_messages WHERE published_at IS NULL`,
      );
    finalLag = Math.max(0, Number(row!.lag));
    maxLag = Math.max(maxLag, finalLag);
  };
  publisherTask = (async () => {
    try {
      while (running) {
        await sampleLag();
        if ((await publisher.runOne()) === 'idle') await delay(10);
      }
    } catch (error) {
      publisherFailure = error;
      running = false;
    }
  })();
  let processed = 0;
  let duplicates = 0;
  // Histórico na wallet disputada exercita o custo crescente das constraints que somam o ledger.
  // Preparação fica fora da latência medida, mas participa da auditoria financeira final.
  for (let i = 0; i < historyEntries; i++) {
    if (
      (await post('/wagering/transactions', bet(0), crypto.randomUUID()))
        .status !== 200
    )
      throw new Error('History fixture failed');
  }
  for (const scenario of [
    'different-wallets',
    'same-wallet',
    'duplicate-burst',
  ] as const) {
    const requests = scenario === 'duplicate-burst' ? 50 : count;
    const duplicate = bet(0);
    const key = crypto.randomUUID();
    const latencies: number[] = [];
    let failures = 0;
    let next = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: Math.min(concurrency, requests) }, async () => {
        while (next < requests) {
          const index = next++;
          const before = performance.now();
          try {
            const result = await post(
              '/wagering/transactions',
              scenario === 'duplicate-burst'
                ? duplicate
                : bet(scenario === 'same-wallet' ? 0 : index % wallets.length),
              scenario === 'duplicate-burst' ? key : crypto.randomUUID(),
            );
            if (result.status !== 200) failures++;
            else if (
              (result.data as { idempotentReplay: boolean }).idempotentReplay
            )
              duplicates++;
            else processed++;
          } catch {
            failures++;
          }
          latencies.push(performance.now() - before);
        }
      }),
    );
    const seconds = (performance.now() - started) / 1000;
    latencies.sort((a, b) => a - b);
    // Percentil nearest-rank; number representa milissegundos e contagens, nunca dinheiro.
    const percentile = (p: number) =>
      latencies[Math.ceil(p * latencies.length) - 1];
    records.push({
      scenario,
      requests,
      concurrency,
      seconds,
      successfulRequestsPerSecond: (requests - failures) / seconds,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      failures,
      errorRate: failures / requests,
    });
  }
  // Drenagem tem prazo: backlog não é escondido por um publisher simulado ou por espera infinita.
  const deadline = Date.now() + drainTimeoutMs;
  let pending = 0;
  do {
    const [row] = await orm.em
      .fork()
      .execute<{ pending: string }[]>(
        'SELECT count(*) AS pending FROM outbox_messages WHERE published_at IS NULL',
      );
    pending = Number(row!.pending);
    if (!pending || publisherFailure) break;
    await delay(100);
  } while (Date.now() < deadline);
  running = false;
  await publisherTask;
  if (publisherFailure) throw new Error('Load publisher failed');
  await sampleLag();
  await assertFinancialConsistency(orm);
  const [effect] = await orm.em
    .fork()
    .execute<{ bets: string; debits: string }[]>(
      `SELECT (SELECT count(*) FROM wager_transactions WHERE kind = 'BET' AND status = 'PROCESSED') AS bets, (SELECT count(*) FROM wallet_ledger_entries WHERE direction = 'DEBIT') AS debits`,
    );
  if (
    processed !== count * 2 + 1 ||
    duplicates !== 49 ||
    effect!.bets !== String(processed + 20 + historyEntries) ||
    effect!.debits !== effect!.bets ||
    pending !== 0
  )
    throw new Error(
      'Load invariant failed: effects, duplicates or Outbox backlog',
    );
  const [database] = await orm.em
    .fork()
    .execute<{ version: string }[]>(
      "SELECT current_setting('server_version') AS version",
    );
  const metrics = telemetry.metrics(finalLag);
  const conflicts = Number(
    metrics.match(/^dwp_lock_conflicts_total (\d+)$/m)?.[1] ?? 0,
  );
  const report = {
    timestamp: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      postgres: database!.version,
      apiInstances: 1,
      poolMax: 8,
      tracingEnabled: process.env.OTEL_ENABLED === 'true',
      structuredLoggingEnabled: true,
      sqs: 'LocalStack (real AWS SDK calls)',
    },
    method: {
      warmup: 20,
      percentile: 'nearest-rank',
      transport: 'HTTP over loopback; real PostgreSQL and SQS',
      latencyIncludesResponseBody: true,
      historyEntries,
      artificialSqsDelayMs: publishDelayMs,
      drainTimeoutMs,
      poolSampleIntervalMs: 10,
    },
    scenarios: records,
    uniqueProcessedDuringMeasurement: processed,
    duplicateReplays: duplicates,
    lockConflicts: conflicts,
    connectionPool: {
      maxBusyConnections,
      maxWaitingRequests,
      averageBusyConnections: poolSamples
        ? busyConnectionSamples / poolSamples
        : 0,
      samples: poolSamples,
    },
    maxObservedOutboxLagSeconds: maxLag,
    finalOutboxLagSeconds: finalLag,
    unpublishedEvents: pending,
    invariant:
      'All wallets non-negative and balance = SUM(CREDIT) - SUM(DEBIT); each BET has one DEBIT',
  };
  await mkdir('docs', { recursive: true });
  await writeFile(
    historyEntries || publishDelayMs
      ? 'docs/load-history-results.json'
      : 'docs/load-results.json',
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Limpeza limitada aos nomes gerados por esta execução; RESTRICT impede remoção em cascata.
  running = false;
  clearInterval(poolSampler);
  await publisherTask;
  try {
    if (urls)
      for (const QueueUrl of Object.values(urls))
        await client.send(new DeleteQueueCommand({ QueueUrl }));
  } finally {
    client.destroy();
    try {
      if (orm) {
        await orm.migrator.down({ schema, to: 0 });
        await orm.em
          .fork()
          .execute(`DROP TABLE IF EXISTS "${schema}".mikro_orm_migrations`);
        await orm.em.fork().execute(`DROP SCHEMA "${schema}" RESTRICT`);
      }
    } finally {
      if (app) await app.close();
      else await orm?.close();
    }
  }
}
