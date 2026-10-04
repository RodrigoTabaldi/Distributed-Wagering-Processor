import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessInboxMessage } from '../../src/application/process-inbox-message.js';
import { CreateWallet } from '../../src/application/create-wallet.js';
import { ProcessBet } from '../../src/application/process-bet.js';
import { ProcessRefund } from '../../src/application/process-refund.js';
import type { RepositorySession } from '../../src/application/ports/repositories.js';
import {
  InboxMessage,
  InboxPayloadConflictError,
} from '../../src/domain/inbox-message.js';
import { Money } from '../../src/domain/money.js';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';

const connect = () => MikroORM.init(createOrmConfig('dwp_test'));
let orm: Awaited<ReturnType<typeof connect>>;
let uow: PostgreSqlUnitOfWork;
const receipt = () => ({
  consumerName: `inbox-tests:${crypto.randomUUID()}`,
  messageId: crypto.randomUUID(),
  payloadHash: 'a'.repeat(64),
  receivedAt: new Date(),
});
// Aguarda a falha real antes de conferir o erro, sem depender do matcher assíncrono.
async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}
async function seed() {
  return new CreateWallet(uow).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
}
async function financialOperation(
  session: RepositorySession,
  wallet: Awaited<ReturnType<typeof seed>>,
  amount = '10.00',
  kind = Kind.Bet,
) {
  // Cada execução teria uma identidade financeira nova: só a Inbox impede a duplicação neste teste.
  const id = crypto.randomUUID();
  const tx = WagerTransaction.create({
    id,
    providerId: 'inbox-tests',
    externalTransactionId: id,
    idempotencyKey: id,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: Money.from({ amount, currency: 'BRL' }),
    createdAt: new Date(),
    ...(kind === Kind.Refund
      ? { referenceExternalTransactionId: crypto.randomUUID() }
      : {}),
  });
  await session.wagers.create(tx);
  return kind === Kind.Refund
    ? new ProcessRefund(uow).executeInTransaction(session, id)
    : new ProcessBet(uow).executeInTransaction(session, id);
}
async function state(id: string) {
  return (
    await orm.em.fork().execute(
      `SELECT balance, version,
    (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = w.id) AS entries,
    (SELECT sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries WHERE wallet_id = w.id)::numeric(20,2)::text AS reconstructed
    FROM wallets w WHERE id = ?`,
      [id],
    )
  )[0];
}

describe('persistent Inbox with financial transactions', () => {
  beforeAll(async () => {
    orm = await connect();
    await orm.migrator.up();
    uow = new PostgreSqlUnitOfWork(orm);
  });
  afterAll(async () => {
    if (orm) await orm.close();
  });

  it('records inbox, debit and ledger together and skips redelivery', async () => {
    const wallet = await seed();
    const props = receipt();
    const handler = new ProcessInboxMessage(uow);
    const operation = async (session: RepositorySession) => {
      await financialOperation(session, wallet);
    };
    expect(await handler.execute(props, operation)).toBe('processed');
    const recorded = await uow.read(({ inbox }) =>
      inbox.find(props.consumerName, props.messageId),
    );
    expect(recorded?.isProcessed()).toBe(true);
    expect(await handler.execute(props, operation)).toBe('duplicate');
    expect(
      (
        await uow.read(({ inbox }) =>
          inbox.find(props.consumerName, props.messageId),
        )
      )?.processedAt,
    ).toEqual(recorded?.processedAt);
    expect(await state(wallet.id)).toMatchObject({
      balance: '90.00',
      reconstructed: '90.00',
      version: 2,
      entries: '2',
    });
  });

  it('rolls back inbox and all financial writes if processing fails, then accepts redelivery', async () => {
    const wallet = await seed();
    const props = receipt();
    const before = await state(wallet.id);
    const handler = new ProcessInboxMessage(uow);
    // Falha após o débito/ledger: mesmo assim, nada pode ser confirmado pela transação externa.
    expect(
      await rejection(
        handler.execute(props, async (session) => {
          await financialOperation(session, wallet);
          throw new Error('Simulated failure before completion');
        }),
      ),
    ).toMatchObject({ message: 'Simulated failure before completion' });
    expect(
      await uow.read(({ inbox }) =>
        inbox.find(props.consumerName, props.messageId),
      ),
    ).toBeUndefined();
    expect(await state(wallet.id)).toEqual(before);
    expect(
      await handler.execute(props, async (session) => {
        await financialOperation(session, wallet);
      }),
    ).toBe('processed');
    expect((await state(wallet.id)).balance).toBe('90.00');
  });

  it('rolls back financial effects when saving inbox completion fails', async () => {
    const wallet = await seed();
    const props = receipt();
    const before = await state(wallet.id);
    const broken = {
      read: uow.read.bind(uow),
      transaction: <T>(op: (session: RepositorySession) => Promise<T>) =>
        uow.transaction((session) =>
          op({
            ...session,
            inbox: {
              find: session.inbox.find.bind(session.inbox),
              receive: session.inbox.receive.bind(session.inbox),
              markProcessed: async () => {
                throw new Error('Simulated inbox write failure');
              },
            },
          }),
        ),
    };
    expect(
      await rejection(
        new ProcessInboxMessage(broken).execute(props, async (session) => {
          await financialOperation(session, wallet);
        }),
      ),
    ).toMatchObject({ message: 'Simulated inbox write failure' });
    expect(await state(wallet.id)).toEqual(before);
    expect(
      await uow.read(({ inbox }) =>
        inbox.find(props.consumerName, props.messageId),
      ),
    ).toBeUndefined();
  });

  it('rejects the same identity with a different hash without invoking its operation', async () => {
    const props = receipt();
    const handler = new ProcessInboxMessage(uow);
    await handler.execute(props, async () => {});
    expect(
      await rejection(
        handler.execute({ ...props, payloadHash: 'b'.repeat(64) }, async () => {
          throw new Error('Must not execute');
        }),
      ),
    ).toBeInstanceOf(InboxPayloadConflictError);
    expect(
      (
        await uow.read(({ inbox }) =>
          inbox.find(props.consumerName, props.messageId),
        )
      )?.payloadHash,
    ).toBe(props.payloadHash);
  });

  it('keeps deduplication after a fresh database connection', async () => {
    const props = receipt();
    await new ProcessInboxMessage(uow).execute(props, async () => {});
    const restarted = await connect();
    try {
      expect(
        await new ProcessInboxMessage(
          new PostgreSqlUnitOfWork(restarted),
        ).execute(props, async () => {
          throw new Error('Must not execute after restart');
        }),
      ).toBe('duplicate');
    } finally {
      await restarted.close();
    }
  });

  it('three independent instances execute one delivery and one debit', async () => {
    const wallet = await seed();
    const props = receipt();
    const connections = await Promise.all([connect(), connect(), connect()]);
    try {
      const results = await Promise.all(
        connections.map((connection) =>
          new ProcessInboxMessage(new PostgreSqlUnitOfWork(connection)).execute(
            props,
            async (session) => {
              await financialOperation(session, wallet);
            },
          ),
        ),
      );
      expect(results.sort()).toEqual(['duplicate', 'duplicate', 'processed']);
      expect(await state(wallet.id)).toMatchObject({
        balance: '90.00',
        reconstructed: '90.00',
        version: 2,
        entries: '2',
      });
    } finally {
      await Promise.all(connections.map((connection) => connection.close()));
    }
  });

  it('allows different consumers to process the same message independently', async () => {
    const props = receipt();
    const handler = new ProcessInboxMessage(uow);
    for (const consumerName of [
      props.consumerName,
      `${props.consumerName}:second`,
    ]) {
      expect(
        await handler.execute({ ...props, consumerName }, async () => {}),
      ).toBe('processed');
    }
  });

  it('resumes an existing unprocessed receipt with its original receive date', async () => {
    const props = receipt();
    await uow.transaction(({ inbox }) =>
      inbox.receive(InboxMessage.receive(props)),
    );
    expect(
      await new ProcessInboxMessage(uow).execute(
        { ...props, receivedAt: new Date() },
        async () => {},
      ),
    ).toBe('processed');
    expect(
      (
        await uow.read(({ inbox }) =>
          inbox.find(props.consumerName, props.messageId),
        )
      )?.receivedAt,
    ).toEqual(props.receivedAt);
  });

  it.each(['rejected', 'pending-reference'] as const)(
    'persists accepted transport for a %s financial result without moving money',
    async (scenario) => {
      const wallet = await seed();
      const props = receipt();
      const before = await state(wallet.id);
      expect(
        await new ProcessInboxMessage(uow).execute(props, async (session) => {
          const result = await financialOperation(
            session,
            wallet,
            scenario === 'rejected' ? '101.00' : '10.00',
            scenario === 'rejected' ? Kind.Bet : Kind.Refund,
          );
          expect(result.status).toBe(
            scenario === 'rejected' ? Status.Rejected : Status.PendingReference,
          );
        }),
      ).toBe('processed');
      expect(
        (
          await uow.read(({ inbox }) =>
            inbox.find(props.consumerName, props.messageId),
          )
        )?.isProcessed(),
      ).toBe(true);
      expect(await state(wallet.id)).toEqual(before);
    },
  );

  it('enforces uniqueness and immutability in SQL and requires transactions for writes', async () => {
    const props = receipt();
    const message = InboxMessage.receive(props);
    expect(
      await rejection(uow.read(({ inbox }) => inbox.receive(message))),
    ).toMatchObject({ name: 'TransactionRequiredError' });
    await new ProcessInboxMessage(uow).execute(props, async () => {});
    expect(
      await rejection(
        orm.em
          .fork()
          .execute(
            'INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES (?, ?, ?, ?)',
            [
              props.consumerName,
              props.messageId,
              props.payloadHash,
              props.receivedAt,
            ],
          ),
      ),
    ).toMatchObject({ code: '23505' });
    expect(
      await rejection(
        orm.em
          .fork()
          .execute(
            'UPDATE inbox_messages SET processed_at = NULL WHERE consumer_name = ? AND message_id = ?',
            [props.consumerName, props.messageId],
          ),
      ),
    ).toMatchObject({ code: '23514' });
  });
});
