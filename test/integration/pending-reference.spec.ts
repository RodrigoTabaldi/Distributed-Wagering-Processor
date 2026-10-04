import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from '../../src/application/create-wallet.js';
import {
  SubmitWager,
  type SubmitWagerInput,
} from '../../src/application/submit-wager.js';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references.js';
import {
  REFERENCE_RETRY_POLICY,
  referenceRetryDelay,
} from '../../src/application/reference-retry-policy.js';
import type { UnitOfWork } from '../../src/application/ports/repositories.js';
import { Money } from '../../src/domain/money.js';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../../src/domain/wager-transaction.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import { PendingReferenceWorker } from '../../src/infrastructure/workers/pending-reference.worker.js';

let schema: string;
const connect = async () => {
  // Um único socket mantém o search_path das consultas SQL no schema exclusivo deste teste.
  const orm = await MikroORM.init({
    ...createOrmConfig('dwp_test'),
    schema,
    pool: { min: 1, max: 1 },
  });
  await orm.em.fork().execute(`SET search_path TO "${schema}"`);
  return orm;
};
let orm: Awaited<ReturnType<typeof connect>>;
let uow: PostgreSqlUnitOfWork;
let retry: ReprocessPendingReferences;
const sql = (query: string, params: unknown[] = []) =>
  orm.em.fork().execute(query, params);
const schedule = (id: string) =>
  uow.read(({ pendingReferences }) => pendingReferences.findSchedule(id));
async function due(id: string) {
  const plan = await schedule(id);
  if (!plan) throw new Error('Expected pending schedule');
  return plan.nextAttemptAt;
}
async function state(walletId: string) {
  return (
    await sql(
      `SELECT balance, version,
    (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = w.id) AS entries,
    (SELECT sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries WHERE wallet_id = w.id)::numeric(20,2)::text AS reconstructed
    FROM wallets w WHERE id = ?`,
      [walletId],
    )
  )[0];
}
async function seed(
  kind: SubmitWagerInput['kind'] = Kind.Refund,
  sourceKind: SubmitWagerInput['kind'] = Kind.Bet,
  amount = '10.00',
) {
  const wallet = await new CreateWallet(uow).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const source: SubmitWagerInput = {
    providerId: 'pending-tests',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind: sourceKind,
    money: { amount, currency: 'BRL' },
  };
  const pending: SubmitWagerInput = {
    ...source,
    kind,
    externalTransactionId: crypto.randomUUID(),
    referenceExternalTransactionId: source.externalTransactionId,
  };
  const key = crypto.randomUUID();
  const result = await new SubmitWager(uow).execute(pending, key);
  expect(result.status).toBe(Status.PendingReference);
  return { wallet, source, pending, key, id: result.transactionId };
}

describe('persisted pending reference retries', () => {
  beforeEach(async () => {
    // Schema gerado pelo teste; não usamos nem removemos registros de outras suites.
    schema = `pending_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const admin = await MikroORM.init(createOrmConfig('dwp_test'));
    try {
      await admin.em.fork().execute(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.close();
    }
    orm = await connect();
    await orm.migrator.up({ schema });
    // O migrator restaura o search_path; recolocamos o schema exclusivo antes dos casos de uso.
    await sql(`SET search_path TO "${schema}"`);
    uow = new PostgreSqlUnitOfWork(orm);
    retry = new ReprocessPendingReferences(uow);
  });
  afterEach(async () => {
    if (!orm) return;
    try {
      await orm.migrator.down({ schema, to: 0 });
      await sql(`DROP TABLE IF EXISTS "${schema}".mikro_orm_migrations`);
      // RESTRICT confirma que só apagamos as tabelas conhecidas do schema criado acima.
      await sql(`DROP SCHEMA "${schema}" RESTRICT`);
    } finally {
      await orm.close();
    }
  });

  it('waits without moving money, preserves schedule on replay and doubles retries', async () => {
    const { wallet, pending, key, id } = await seed();
    const before = await state(wallet.id);
    let plan = (await schedule(id))!;
    expect(plan.attempts).toBe(0);
    await new SubmitWager(uow).execute(pending, key);
    expect(await schedule(id)).toEqual(plan);
    expect(
      await retry.runOne(id, new Date(plan.nextAttemptAt.getTime() - 1)),
    ).toBe('skipped');
    for (let attempts = 1; attempts <= 7; attempts++) {
      const now = plan.nextAttemptAt;
      expect(await retry.runOne(id, now)).toBe('rescheduled');
      plan = (await schedule(id))!;
      expect(plan).toEqual({
        attempts,
        nextAttemptAt: new Date(now.getTime() + referenceRetryDelay(attempts)),
      });
    }
    expect(await state(wallet.id)).toEqual(before);
  });

  it.each([
    [Kind.Refund, Kind.Bet, '100.00'],
    [Kind.Rollback, Kind.Bet, '100.00'],
    [Kind.Rollback, Kind.Win, '100.00'],
    [Kind.Win, Kind.Bet, '100.00'],
  ] as const)(
    'resumes %s after %s arrives, with exactly one financial effect',
    async (kind, sourceKind, balance) => {
      const { wallet, source, pending, key, id } = await seed(kind, sourceKind);
      await new SubmitWager(uow).execute(source, crypto.randomUUID());
      expect(await retry.runOne(id, await due(id))).toBe('processed');
      expect(await schedule(id)).toBeUndefined();
      expect(await retry.runOne(id)).toBe('skipped');
      expect(await state(wallet.id)).toMatchObject({
        balance,
        reconstructed: balance,
        version: 3,
        entries: '3',
      });
      const replay = await new SubmitWager(uow).execute(pending, key);
      expect(replay.transactionId).toBe(id);
      expect(replay.status).toBe(Status.Processed);
      expect(replay.idempotentReplay).toBe(true);
      expect((await state(wallet.id)).entries).toBe('3');
    },
  );

  it('resumes rollback of a REFUND after its BET and refund arrive', async () => {
    const { wallet, source, id } = await seed(Kind.Rollback, Kind.Refund);
    const bet: SubmitWagerInput = {
      ...source,
      kind: Kind.Bet,
      externalTransactionId: crypto.randomUUID(),
    };
    await new SubmitWager(uow).execute(bet, crypto.randomUUID());
    await new SubmitWager(uow).execute(
      { ...source, referenceExternalTransactionId: bet.externalTransactionId },
      crypto.randomUUID(),
    );
    expect(await retry.runOne(id, await due(id))).toBe('processed');
    expect(await state(wallet.id)).toMatchObject({
      balance: '90.00',
      reconstructed: '90.00',
      version: 4,
      entries: '4',
    });
  });

  it.each(['missing', 'pending'] as const)(
    'rejects unresolved %s reference only at the retry limit',
    async (scenario) => {
      const { wallet, source, pending, key, id } = await seed();
      if (scenario === 'pending') {
        // Referência existe, mas não pode ser revertida antes de sua própria movimentação.
        const tx = WagerTransaction.create({
          ...source,
          id: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          payloadHash: 'a'.repeat(64),
          money: Money.from(source.money),
          createdAt: new Date(),
        });
        await uow.transaction(({ wagers }) => wagers.create(tx));
      }
      const before = await state(wallet.id);
      for (
        let attempt = 1;
        attempt <= REFERENCE_RETRY_POLICY.maxAttempts;
        attempt++
      ) {
        expect(await retry.runOne(id, await due(id))).toBe(
          attempt === REFERENCE_RETRY_POLICY.maxAttempts
            ? 'rejected'
            : 'rescheduled',
        );
      }
      expect(await schedule(id)).toBeUndefined();
      const replay = await new SubmitWager(uow).execute(pending, key);
      expect(replay.status).toBe(Status.Rejected);
      expect(replay.failureCode).toBe(
        scenario === 'missing'
          ? FailureCode.ReferenceNotFound
          : FailureCode.ReferenceNotProcessed,
      );
      expect(await state(wallet.id)).toEqual(before);
    },
  );

  it.each([false, true])(
    'at TTL, gives an arrived reference one final chance: %s',
    async (arrived) => {
      const { source, id } = await seed();
      const tx = await uow.read(({ wagers }) => wagers.findById(id));
      if (arrived)
        await new SubmitWager(uow).execute(source, crypto.randomUUID());
      expect(
        await retry.runOne(
          id,
          new Date(tx!.createdAt.getTime() + REFERENCE_RETRY_POLICY.ttlMs),
        ),
      ).toBe(arrived ? 'processed' : 'rejected');
      expect(await schedule(id)).toBeUndefined();
    },
  );

  it('rolls back attempts, wallet and ledger on a technical failure and continues other wallets', async () => {
    const bad = await seed();
    const good = await seed();
    for (const item of [bad, good])
      await new SubmitWager(uow).execute(item.source, crypto.randomUUID());
    const before = await state(bad.wallet.id);
    const plan = await schedule(bad.id);
    const failing: UnitOfWork = {
      read: (op) => uow.read(op),
      transaction: (op) =>
        uow.transaction((session) =>
          op({
            ...session,
            ledger: {
              ...session.ledger,
              findByTransaction: session.ledger.findByTransaction.bind(
                session.ledger,
              ),
              findByWallet: session.ledger.findByWallet.bind(session.ledger),
              create: async (entry) => {
                if (entry.walletId === bad.wallet.id)
                  throw new Error('Simulated write failure');
                await session.ledger.create(entry);
              },
            },
          }),
        ),
    };
    const now = new Date(
      Math.max((await due(bad.id)).getTime(), (await due(good.id)).getTime()),
    );
    const outcomes = await new ReprocessPendingReferences(failing).runDue(now);
    expect(outcomes.find((r) => r.transactionId === bad.id)?.outcome).toBe(
      'failed',
    );
    expect(outcomes.find((r) => r.transactionId === good.id)?.outcome).toBe(
      'processed',
    );
    expect(await state(bad.wallet.id)).toEqual(before);
    expect(await schedule(bad.id)).toEqual(plan);
    expect(await retry.runOne(bad.id, now)).toBe('processed');
    expect((await state(bad.wallet.id)).entries).toBe('3');
  });

  it('keeps its retry schedule across a new database connection', async () => {
    const { id } = await seed();
    await retry.runOne(id, await due(id));
    const plan = await schedule(id);
    const restarted = await connect();
    try {
      const nextUow = new PostgreSqlUnitOfWork(restarted);
      expect(
        await nextUow.read(({ pendingReferences }) =>
          pendingReferences.findSchedule(id),
        ),
      ).toEqual(plan);
      expect(
        await new ReprocessPendingReferences(nextUow).runOne(
          id,
          new Date(plan!.nextAttemptAt.getTime() - 1),
        ),
      ).toBe('skipped');
    } finally {
      await restarted.close();
    }
  });

  it('two independent workers never credit the same pending refund twice', async () => {
    const { source, wallet, id } = await seed();
    await new SubmitWager(uow).execute(source, crypto.randomUUID());
    const another = await connect();
    try {
      const now = await due(id);
      const results = await Promise.all([
        retry.runOne(id, now),
        new ReprocessPendingReferences(
          new PostgreSqlUnitOfWork(another),
        ).runOne(id, now),
      ]);
      expect(results.sort()).toEqual(['processed', 'skipped']);
      expect(await state(wallet.id)).toMatchObject({
        balance: '100.00',
        reconstructed: '100.00',
        entries: '3',
        version: 3,
      });
    } finally {
      await another.close();
    }
  });

  it('skips a busy wallet and processes another wallet in the same batch', async () => {
    const busy = await seed();
    const free = await seed();
    for (const item of [busy, free])
      await new SubmitWager(uow).execute(item.source, crypto.randomUUID());
    const locker = await connect();
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const hold = new PostgreSqlUnitOfWork(locker).transaction(
      async ({ wallets }) => {
        await wallets.findByIdForUpdate(busy.wallet.id);
        locked();
        await gate;
      },
    );
    try {
      await ready;
      const now = new Date(
        Math.max(
          (await due(busy.id)).getTime(),
          (await due(free.id)).getTime(),
        ),
      );
      const outcomes = await retry.runDue(now);
      expect(outcomes.find((r) => r.transactionId === busy.id)?.outcome).toBe(
        'skipped',
      );
      expect(outcomes.find((r) => r.transactionId === free.id)?.outcome).toBe(
        'processed',
      );
    } finally {
      release();
      await hold;
      await locker.close();
    }
    expect(await retry.runOne(busy.id, await due(busy.id))).toBe('processed');
  });

  it('processes a reference that arrives on the last allowed attempt', async () => {
    const { source, id } = await seed();
    for (
      let attempt = 1;
      attempt < REFERENCE_RETRY_POLICY.maxAttempts;
      attempt++
    ) {
      expect(await retry.runOne(id, await due(id))).toBe('rescheduled');
    }
    await new SubmitWager(uow).execute(source, crypto.randomUUID());
    expect(await retry.runOne(id, await due(id))).toBe('processed');
    expect(await schedule(id)).toBeUndefined();
  });

  it('processes a zero refund without introducing a ledger entry or wallet version', async () => {
    const { source, wallet, id } = await seed(Kind.Refund, Kind.Bet, '0.00');
    const before = await state(wallet.id);
    await new SubmitWager(uow).execute(source, crypto.randomUUID());
    expect(await retry.runOne(id, await due(id))).toBe('processed');
    expect(await state(wallet.id)).toEqual(before);
    expect(await schedule(id)).toBeUndefined();
  });

  it('rejects a reference that arrived rejected instead of retrying forever', async () => {
    const { source, wallet, id } = await seed(Kind.Refund, Kind.Bet, '101.00');
    await new SubmitWager(uow).execute(source, crypto.randomUUID());
    const before = await state(wallet.id);
    expect(await retry.runOne(id, await due(id))).toBe('rejected');
    expect(
      (await uow.read(({ wagers }) => wagers.findById(id)))?.failureCode,
    ).toBe(FailureCode.ReferenceNotProcessed);
    expect(await state(wallet.id)).toEqual(before);
    expect(await schedule(id)).toBeUndefined();
  });

  it('backfills old pending references and preserves financial records when migrating', async () => {
    const { wallet, id } = await seed();
    const before = await state(wallet.id);
    // Volta ao schema original, inclusive removendo metadados posteriores; só em schema descartável.
    await orm.migrator.down({ schema, to: 'Migration202610030001' });
    await orm.migrator.up({ schema });
    await sql(`SET search_path TO "${schema}"`);
    expect((await schedule(id))?.attempts).toBe(0);
    expect((await due(id)).getTime()).toBeLessThanOrEqual(Date.now());
    expect(await state(wallet.id)).toEqual(before);
    expect(await retry.runOne(id, new Date())).toBe('rescheduled');
  });

  it('polls automatically and shuts down before the database pool closes', async () => {
    const { source, id } = await seed();
    await new SubmitWager(uow).execute(source, crypto.randomUUID());
    const worker = new PendingReferenceWorker(retry);
    worker.onApplicationBootstrap();
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const tx = await uow.read(({ wagers }) => wagers.findById(id));
        if (tx?.status === Status.Processed) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(
        (await uow.read(({ wagers }) => wagers.findById(id)))?.status,
      ).toBe(Status.Processed);
    } finally {
      await worker.beforeApplicationShutdown();
    }
    await worker.tick();
    expect(await schedule(id)).toBeUndefined();
  });
});
