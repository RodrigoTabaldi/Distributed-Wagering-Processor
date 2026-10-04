import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { CreateWallet } from '../../src/application/create-wallet.js';
import {
  SubmitWager,
  type SubmitWagerInput,
} from '../../src/application/submit-wager.js';
import { PublishOutbox } from '../../src/application/publish-outbox.js';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references.js';
import type {
  UnitOfWork,
  RepositorySession,
} from '../../src/application/ports/repositories.js';
import {
  FailureCode,
  WagerTransactionKind as Kind,
} from '../../src/domain/wager-transaction.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import {
  createSqsClient,
  provisionQueues,
  SqsTransport,
  type QueueUrls,
} from '../../src/infrastructure/messaging/sqs.js';
import { WagerConsumer } from '../../src/interfaces/sqs/wager-consumer.js';
import { SqsConsumerWorker } from '../../src/infrastructure/workers/sqs-consumer.worker.js';
import { OutboxPublisherWorker } from '../../src/infrastructure/workers/outbox-publisher.worker.js';
import type { QueueDelivery } from '../../src/application/ports/messaging.js';

let schema: string;
const connect = async () => {
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
let client: ReturnType<typeof createSqsClient>;
let urls: QueueUrls;
let transport: SqsTransport;
const children: ChildProcess[] = [];
async function childWorker() {
  const child = fork(
    fileURLToPath(new URL('../helpers/messaging-worker.ts', import.meta.url)),
    [],
    {
      execPath: process.execPath,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        MESSAGING_TEST_SCHEMA: schema,
        MESSAGING_TEST_URLS: JSON.stringify(urls),
      },
    },
  );
  children.push(child);
  const messages: { phase: string; name?: string; receiptHandle?: string }[] =
    [];
  child.on(
    'message',
    (message: { phase: string; name?: string; receiptHandle?: string }) =>
      messages.push(message),
  );
  const wait = (phase: string) =>
    poll(
      async () => {
        if (messages.some((message) => message.phase === 'error'))
          throw new Error('Child worker failed');
        return messages.find((message) => message.phase === phase);
      },
      (message) => message !== undefined,
      10000,
    );
  await wait('ready');
  return { child, wait };
}
async function stopChild(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGKILL',
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill(signal);
  await exited;
}
const sql = (query: string, params: unknown[] = []) =>
  orm.em.fork().execute(query, params);
const consumer = (work: UnitOfWork = uow, queue = transport) =>
  new WagerConsumer(work, queue, new Set(['provider-a']));
async function seed(
  amount = '10.00',
  kind: SubmitWagerInput['kind'] = Kind.Bet,
) {
  const wallet = await new CreateWallet(uow).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const input: SubmitWagerInput = {
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: { amount, currency: 'BRL' },
  };
  const key = crypto.randomUUID();
  const envelope = {
    messageId: crypto.randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...input, idempotencyKey: key },
  };
  return { wallet, input, key, envelope };
}
async function send(body: unknown, groupId: string = crypto.randomUUID()) {
  await client.send(
    new SendMessageCommand({
      QueueUrl: urls.input,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}
async function poll<T>(
  operation: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 5000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await operation();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await operation();
  }
  if (!ready(value)) throw new Error('Timed out waiting for verified state');
  return value;
}
async function delivery(): Promise<QueueDelivery> {
  return (
    await poll(
      () => transport.receive(),
      (items) => items.length > 0,
    )
  )[0]!;
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
async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected rejection');
}
function intercept(
  change: (session: RepositorySession) => RepositorySession,
): UnitOfWork {
  return {
    read: (op) => uow.read(op),
    transaction: (op, signal) =>
      uow.transaction((session) => op(change(session)), signal),
  };
}
async function events(queueUrl = urls.events) {
  return (
    (
      await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
        }),
      )
    ).Messages ?? []
  );
}

// PostgreSQL e LocalStack reais, sem substituir os adapters de banco/fila por mocks.
describe('SQS, Inbox, events, Outbox and recovery', () => {
  beforeEach(async () => {
    schema = `messaging_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const admin = await MikroORM.init(createOrmConfig('dwp_test'));
    try {
      await admin.em.fork().execute(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.close();
    }
    orm = await connect();
    await orm.migrator.up({ schema });
    await sql(`SET search_path TO "${schema}"`);
    uow = new PostgreSqlUnitOfWork(orm);
    client = createSqsClient();
    urls = await provisionQueues(
      client,
      `test_${crypto.randomUUID().replaceAll('-', '')}_`,
    );
    transport = new SqsTransport(client, urls, 0);
  });
  afterEach(async () => {
    // Encerra somente processos filhos criados por esta suite antes de remover seu schema.
    await Promise.all(children.splice(0).map((child) => stopChild(child)));
    try {
      if (client && urls)
        for (const QueueUrl of Object.values(urls))
          await client.send(new DeleteQueueCommand({ QueueUrl }));
    } finally {
      client?.destroy();
      if (orm) {
        try {
          await orm.migrator.down({ schema, to: 0 });
          await sql(`DROP TABLE "${schema}".mikro_orm_migrations`);
          await sql(`DROP SCHEMA "${schema}" RESTRICT`);
        } finally {
          await orm.close();
        }
      }
    }
  });

  it('commits Inbox, debit, ledger and Outbox before ACK and shares HTTP idempotency', async () => {
    const { wallet, input, key, envelope } = await seed();
    await send(envelope, wallet.id);
    expect(await consumer().handle(await delivery())).toBe('acknowledged');
    expect(await transport.receive()).toEqual([]);
    expect(await state(wallet.id)).toMatchObject({
      balance: '90.00',
      reconstructed: '90.00',
      version: 2,
      entries: '2',
    });
    const result = await new SubmitWager(uow).execute(input, key);
    expect(result.idempotentReplay).toBe(true);
    const rows = await sql(
      `SELECT event_type, payload FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`,
      [result.transactionId],
    );
    expect(
      rows.map((row) => row.event_type).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(rows[0].payload).toMatchObject({
      correlationId: envelope.messageId,
      causationId: envelope.messageId,
      version: 1,
    });
    expect(
      (
        await sql(
          'SELECT count(*) AS total FROM inbox_messages WHERE processed_at IS NOT NULL',
        )
      )[0].total,
    ).toBe('1');
    // Até aqui nenhum evento foi enviado: somente a Outbox foi persistida.
    expect(await events()).toEqual([]);
  });

  it('recovers delivery after commit but before ACK without duplicating effects', async () => {
    const { wallet, envelope } = await seed();
    await send(envelope);
    const original = await delivery();
    class LostAck extends SqsTransport {
      override async acknowledge(): Promise<void> {
        throw new Error('Process lost before ACK');
      }
    }
    expect(
      await failure(
        consumer(uow, new LostAck(client, urls, 0)).handle(original),
      ),
    ).toBeInstanceOf(Error);
    expect((await state(wallet.id)).balance).toBe('90.00');
    await transport.changeVisibility(original, 0);
    const restarted = await connect();
    try {
      expect(
        await consumer(new PostgreSqlUnitOfWork(restarted)).handle(
          await delivery(),
        ),
      ).toBe('acknowledged');
    } finally {
      await restarted.close();
    }
    expect(await state(wallet.id)).toMatchObject({
      balance: '90.00',
      version: 2,
      entries: '2',
      reconstructed: '90.00',
    });
  });

  it('rolls back all writes and retries transient failure with SQS visibility backoff', async () => {
    const { wallet, envelope } = await seed();
    const before = await state(wallet.id);
    const broken = intercept((session) => ({
      ...session,
      outbox: new Proxy(session.outbox, {
        get(target, key) {
          if (key === 'create')
            return async () => {
              throw new Error('Transient write failure');
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    }));
    await send(envelope);
    expect(await consumer(broken).handle(await delivery())).toBe('retry');
    expect(await state(wallet.id)).toEqual(before);
    expect(
      (await sql('SELECT count(*) AS total FROM inbox_messages'))[0].total,
    ).toBe('0');
    expect(await transport.receive()).toEqual([]);
    const second = await delivery();
    expect(second.receiveCount).toBe(2);
    expect(await consumer().handle(second)).toBe('acknowledged');
    expect((await state(wallet.id)).balance).toBe('90.00');
  });

  it.each(['json', 'provider', 'money', 'envelope', 'hash-conflict'] as const)(
    'moves permanent %s input to DLQ before deleting origin',
    async (scenario) => {
      const { envelope, wallet } = await seed();
      let body: unknown = envelope;
      if (scenario === 'json') body = '{';
      if (scenario === 'provider')
        body = {
          ...envelope,
          data: { ...envelope.data, providerId: 'unknown-provider' },
        };
      if (scenario === 'money')
        body = {
          ...envelope,
          data: { ...envelope.data, money: { amount: 10, currency: 'BRL' } },
        };
      if (scenario === 'envelope') body = { ...envelope, type: 'Unexpected' };
      if (scenario === 'hash-conflict') {
        await send(envelope);
        await consumer().handle(await delivery());
        body = {
          ...envelope,
          data: {
            ...envelope.data,
            money: { amount: '11.00', currency: 'BRL' },
          },
        };
      }
      const before = await state(wallet.id);
      await send(body);
      expect(await consumer().handle(await delivery())).toBe('dead-lettered');
      const dead = await poll(
        () => events(urls.dlq),
        (rows) => rows.length > 0,
      );
      expect(dead[0]?.Body).toBe(
        typeof body === 'string' ? body : JSON.stringify(body),
      );
      expect(await transport.receive()).toEqual([]);
      expect(await state(wallet.id)).toEqual(before);
    },
  );

  it('does not ACK permanent input when sending to DLQ fails', async () => {
    await seed();
    await send('{');
    const original = await delivery();
    const unavailableDlq = new SqsTransport(
      client,
      { ...urls, dlq: `${urls.dlq}-missing` },
      0,
    );
    expect(
      await failure(consumer(uow, unavailableDlq).handle(original)),
    ).toBeInstanceOf(Error);
    await transport.changeVisibility(original, 0);
    expect((await delivery()).body).toBe('{');
  });

  it('moves an unresolved technical failure to DLQ on the fifth attempt', async () => {
    const { wallet, envelope } = await seed();
    await send(envelope);
    for (let i = 1; i < 5; i++)
      await transport.changeVisibility(await delivery(), 0);
    const fifth = await delivery();
    expect(fifth.receiveCount).toBe(5);
    const failing = intercept((session) => ({
      ...session,
      outbox: new Proxy(session.outbox, {
        get(target, key) {
          if (key === 'create')
            return async () => {
              throw new Error('Persistent infrastructure outage');
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    }));
    expect(await consumer(failing).handle(fifth)).toBe('dead-lettered');
    expect((await state(wallet.id)).balance).toBe('100.00');
    expect(
      (
        await poll(
          () => events(urls.dlq),
          (rows) => rows.length > 0,
        )
      )[0]?.Body,
    ).toBe(JSON.stringify(envelope));
    expect(
      (await sql('SELECT count(*) AS total FROM inbox_messages'))[0].total,
    ).toBe('0');
  });

  it('uses the configured redrive policy after five unacknowledged receives', async () => {
    const { envelope } = await seed();
    const attributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: urls.input,
        AttributeNames: ['RedrivePolicy'],
      }),
    );
    expect(
      JSON.parse(attributes.Attributes!.RedrivePolicy!).maxReceiveCount,
    ).toBe(5);
    await send(envelope);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const item = await delivery();
      expect(item.receiveCount).toBe(attempt);
      await transport.changeVisibility(item, 0);
    }
    // Uma nova busca dispara o redrive nativo do SQS; não há delete nem débito da aplicação.
    await transport.receive();
    expect(
      (
        await poll(
          () => events(urls.dlq),
          (rows) => rows.length > 0,
        )
      )[0]?.Body,
    ).toBe(JSON.stringify(envelope));
  });

  it('acknowledges business rejection and emits a rejection event without a balance event', async () => {
    const { wallet, envelope, input, key } = await seed('101.00');
    await send(envelope);
    expect(await consumer().handle(await delivery())).toBe('acknowledged');
    const result = await new SubmitWager(uow).execute(input, key);
    expect(result.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(
      (
        await sql(
          `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`,
          [result.transactionId],
        )
      ).map((row) => row.event_type),
    ).toEqual(['WagerTransactionRejected']);
    expect((await state(wallet.id)).balance).toBe('100.00');
    expect(await events(urls.dlq)).toEqual([]);
  });

  it.each([Kind.Loss, Kind.Bet] as const)(
    'emits Processed for %s zero without BalanceChanged',
    async (kind) => {
      const { input, key } = await seed('0.00', kind);
      const result = await new SubmitWager(uow).execute(input, key);
      expect(
        (
          await sql(
            `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`,
            [result.transactionId],
          )
        ).map((row) => row.event_type),
      ).toEqual(['WagerTransactionProcessed']);
    },
  );

  it('persists PendingReference once and later emits Processed and BalanceChanged', async () => {
    const { input, wallet } = await seed();
    const refund: SubmitWagerInput = {
      ...input,
      kind: Kind.Refund,
      externalTransactionId: crypto.randomUUID(),
      referenceExternalTransactionId: input.externalTransactionId,
    };
    const pending = await new SubmitWager(uow).execute(
      refund,
      crypto.randomUUID(),
    );
    await new SubmitWager(uow).execute(input, crypto.randomUUID());
    const plan = await uow.read(({ pendingReferences }) =>
      pendingReferences.findSchedule(pending.transactionId),
    );
    expect(
      await new ReprocessPendingReferences(uow).runOne(
        pending.transactionId,
        plan!.nextAttemptAt,
      ),
    ).toBe('processed');
    expect(
      (
        await sql(
          `SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?`,
          [pending.transactionId],
        )
      )
        .map((row) => row.event_type)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect((await state(wallet.id)).balance).toBe('100.00');
  });

  it('a restarted publisher publishes committed events that were never sent', async () => {
    await seed();
    expect(await events()).toEqual([]);
    const restarted = await connect();
    try {
      const publisher = new PublishOutbox(
        new PostgreSqlUnitOfWork(restarted),
        transport,
      );
      expect(await publisher.runOne()).toBe('published');
      expect(await publisher.runOne()).toBe('published');
      expect(await publisher.runOne()).toBe('idle');
    } finally {
      await restarted.close();
    }
    expect(
      (
        await sql(
          'SELECT count(*) AS total FROM outbox_messages WHERE published_at IS NOT NULL',
        )
      )[0].total,
    ).toBe('2');
    const published = await poll(
      () => events(),
      (rows) => rows.length > 0,
    );
    expect(
      published.every((message) => JSON.parse(message.Body!).eventId),
    ).toBe(true);
  });

  it('two publishers skip locked events and both publish without claiming the same record', async () => {
    await seed();
    const another = await connect();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const ids: string[] = [];
    const held = new PublishOutbox(uow, {
      publish: async (message) => {
        ids.push(message.id);
        started();
        await gate;
        await transport.publish(message);
      },
    }).runOne();
    try {
      await ready;
      expect(
        await new PublishOutbox(new PostgreSqlUnitOfWork(another), {
          publish: async (message) => {
            ids.push(message.id);
            await transport.publish(message);
          },
        }).runOne(),
      ).toBe('published');
      expect(new Set(ids).size).toBe(2);
    } finally {
      release();
      await held;
      await another.close();
    }
    expect(
      (
        await sql(
          'SELECT count(*) AS total FROM outbox_messages WHERE published_at IS NOT NULL',
        )
      )[0].total,
    ).toBe('2');
  });

  it('publisher shutdown waits for active send and leaves remaining events pending', async () => {
    await seed();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = new OutboxPublisherWorker(
      new PublishOutbox(uow, {
        publish: async (message) => {
          started();
          await gate;
          await transport.publish(message);
        },
      }),
    );
    const active = worker.tick();
    try {
      await ready;
      expect(worker.tick()).toBe(active);
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(
        (
          await sql(
            'SELECT count(*) AS total FROM outbox_messages WHERE published_at IS NULL',
          )
        )[0].total,
      ).toBe('1');
      await worker.tick();
      expect(
        (
          await sql(
            'SELECT count(*) AS total FROM outbox_messages WHERE published_at IS NOT NULL',
          )
        )[0].total,
      ).toBe('1');
    } finally {
      release();
      await worker.stop();
    }
  });

  it('reschedules publication failure and only retries due events', async () => {
    await seed();
    const publisher = new PublishOutbox(uow, {
      publish: async () => {
        throw new Error('SQS unavailable');
      },
    });
    const now = new Date();
    expect(await publisher.runOne(now)).toBe('rescheduled');
    expect(await publisher.runOne(now)).toBe('rescheduled');
    expect(await publisher.runOne(now)).toBe('idle');
    const rows = await sql(
      'SELECT attempts, next_attempt_at FROM outbox_messages',
    );
    expect(rows.every((row) => row.attempts === 1)).toBe(true);
    const due = new Date(
      Math.max(...rows.map((row) => new Date(row.next_attempt_at).getTime())),
    );
    expect(await new PublishOutbox(uow, transport).runOne(due)).toBe(
      'published',
    );
  });

  it('keeps the same eventId after send succeeds but publication commit fails', async () => {
    await seed();
    const broken = intercept((session) => ({
      ...session,
      outbox: new Proxy(session.outbox, {
        get(target, key) {
          if (key === 'save')
            return async () => {
              throw new Error('Crash after send');
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    }));
    const sent: string[] = [];
    const publisher = {
      publish: async (message: Parameters<SqsTransport['publish']>[0]) => {
        sent.push(message.id);
        await transport.publish(message);
      },
    };
    expect(
      await failure(new PublishOutbox(broken, publisher).runOne()),
    ).toBeInstanceOf(Error);
    expect(await new PublishOutbox(uow, publisher).runOne()).toBe('published');
    expect(sent[0]).toBe(sent[1]);
    expect(
      (
        await sql(
          'SELECT count(*) AS total FROM outbox_messages WHERE published_at IS NOT NULL',
        )
      )[0].total,
    ).toBe('1');
  });

  it('stops new polling and waits for an in-flight financial operation before ACK', async () => {
    const { wallet, envelope } = await seed();
    await send(envelope);
    const heldConnection = await connect();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const heldUow = new PostgreSqlUnitOfWork(heldConnection);
    const blocked: UnitOfWork = {
      read: (op) => heldUow.read(op),
      transaction: (op, signal) =>
        heldUow.transaction(async (session) => {
          entered();
          await gate;
          return op(session);
        }, signal),
    };
    const worker = new SqsConsumerWorker(consumer(blocked), transport);
    worker.start();
    try {
      await ready;
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(stopped).toBe(true);
      expect((await state(wallet.id)).balance).toBe('90.00');
      expect(await transport.receive()).toEqual([]);
    } finally {
      release();
      await worker.stop();
      await heldConnection.close();
    }
  });

  it('cancels blocked SQL at the shutdown deadline and returns SQS visibility after rollback', async () => {
    const { wallet, envelope } = await seed();
    await send(envelope);
    const lockedConnection = await connect();
    const consumerConnection = await connect();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lock = new PostgreSqlUnitOfWork(lockedConnection).transaction(
      async ({ wallets }) => {
        await wallets.findByIdForUpdate(wallet.id);
        entered();
        await gate;
      },
    );
    const worker = new SqsConsumerWorker(
      consumer(new PostgreSqlUnitOfWork(consumerConnection)),
      transport,
      100,
    );
    try {
      await ready;
      worker.start();
      // Aguarda a mensagem ficar em voo antes de encerrar; o débito está bloqueado no PostgreSQL.
      await poll(
        async () =>
          (
            await client.send(
              new GetQueueAttributesCommand({
                QueueUrl: urls.input,
                AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
              }),
            )
          ).Attributes?.ApproximateNumberOfMessagesNotVisible,
        (count) => count === '1',
      );
      await worker.stop();
      expect((await state(wallet.id)).balance).toBe('100.00');
      expect((await delivery()).receiveCount).toBeGreaterThan(1);
      expect(
        (await sql('SELECT count(*) AS total FROM inbox_messages'))[0].total,
      ).toBe('0');
    } finally {
      release();
      await lock;
      await worker.stop();
      await lockedConnection.close();
      await consumerConnection.close();
    }
  });

  it('survives a process killed after financial commit and before ACK', async () => {
    const { wallet, envelope } = await seed();
    await send(envelope);
    const worker = await childWorker();
    worker.child.send({ action: 'before-ack' });
    const committed = await worker.wait('before-ack');
    expect((await state(wallet.id)).balance).toBe('90.00');
    await stopChild(worker.child);
    // A mensagem original continua em voo após o crash; aceleramos somente o timeout de visibilidade.
    const attrs = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: urls.input,
        AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('1');
    await client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: urls.input,
        ReceiptHandle: committed!.receiptHandle!,
        VisibilityTimeout: 0,
      }),
    );
    const redelivery = await delivery();
    expect(redelivery.receiveCount).toBe(2);
    expect(await consumer().handle(redelivery)).toBe('acknowledged');
    expect(await state(wallet.id)).toMatchObject({
      balance: '90.00',
      version: 2,
      entries: '2',
      reconstructed: '90.00',
    });
  });

  it('a second process publishes Outbox events after the first dies before publication', async () => {
    const { input, key } = await seed();
    const first = await childWorker();
    first.child.send({ action: 'after-commit', input, key });
    await first.wait('after-commit');
    await stopChild(first.child);
    expect(await events()).toEqual([]);
    const second = await childWorker();
    second.child.send({ action: 'publish' });
    await second.wait('closed');
    expect(
      (
        await sql(
          'SELECT count(*) AS total FROM outbox_messages WHERE published_at IS NULL',
        )
      )[0].total,
    ).toBe('0');
    expect(
      (
        await poll(
          () => events(),
          (rows) => rows.length > 0,
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('SIGTERM stops a real consumer process and releases a blocked delivery without debit', async () => {
    const { wallet, envelope } = await seed();
    const locker = await connect();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lock = new PostgreSqlUnitOfWork(locker).transaction(
      async ({ wallets }) => {
        await wallets.findByIdForUpdate(wallet.id);
        entered();
        await gate;
      },
    );
    try {
      await ready;
      await send(envelope);
      const worker = await childWorker();
      worker.child.send({ action: 'start' });
      await worker.wait('started');
      await poll(
        async () =>
          (
            await client.send(
              new GetQueueAttributesCommand({
                QueueUrl: urls.input,
                AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
              }),
            )
          ).Attributes?.ApproximateNumberOfMessagesNotVisible,
        (value) => value === '1',
      );
      const closed = worker.wait('closed');
      if (process.platform === 'win32')
        worker.child.send({ action: 'sigterm' });
      else await stopChild(worker.child, 'SIGTERM');
      await closed;
      expect((await state(wallet.id)).balance).toBe('100.00');
      expect((await delivery()).receiveCount).toBeGreaterThan(1);
    } finally {
      release();
      await lock;
      await locker.close();
    }
  });
});
