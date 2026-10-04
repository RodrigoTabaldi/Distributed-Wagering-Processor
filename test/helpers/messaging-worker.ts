import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';
import {
  createSqsClient,
  SqsTransport,
  type QueueUrls,
} from '../../src/infrastructure/messaging/sqs.js';
import { WagerConsumer } from '../../src/interfaces/sqs/wager-consumer.js';
import { SqsConsumerWorker } from '../../src/infrastructure/workers/sqs-consumer.worker.js';
import { PublishOutbox } from '../../src/application/publish-outbox.js';
import {
  SubmitWager,
  type SubmitWagerInput,
} from '../../src/application/submit-wager.js';

const schema = process.env.MESSAGING_TEST_SCHEMA ?? '';
if (!/^messaging_test_[a-f0-9]{32}$/.test(schema))
  throw new Error('Expected owned test schema');
const orm = await MikroORM.init({
  ...createOrmConfig('dwp_test'),
  schema,
  pool: { min: 1, max: 1 },
});
await orm.em.fork().execute(`SET search_path TO "${schema}"`);
const client = createSqsClient();
const urls = JSON.parse(process.env.MESSAGING_TEST_URLS ?? '') as QueueUrls;
const uow = new PostgreSqlUnitOfWork(orm);
let worker: SqsConsumerWorker | undefined;
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await worker?.stop();
  await orm.close();
  client.destroy();
  process.send?.({ phase: 'closed' });
  process.disconnect?.();
}
// Processo filho real: o teste envia SIGTERM e só considera seguro o fechamento após rollback/ACK.
process.on('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
process.on(
  'message',
  async (command: {
    action: string;
    input?: SubmitWagerInput;
    key?: string;
  }) => {
    try {
      const transport = new SqsTransport(client, urls, 0);
      if (command.action === 'before-ack') {
        class HeldAck extends SqsTransport {
          override async acknowledge(
            delivery: Parameters<SqsTransport['acknowledge']>[0],
          ): Promise<void> {
            process.send?.({
              phase: 'before-ack',
              receiptHandle: delivery.receiptHandle,
            });
            // O pai encerra o processo neste ponto; o commit já ocorreu, o ACK ainda não.
            await new Promise<void>(() => {});
          }
        }
        const held = new HeldAck(client, urls, 0);
        const [item] = await held.receive();
        if (!item) throw new Error('Expected delivery');
        await new WagerConsumer(uow, held, new Set(['provider-a'])).handle(
          item,
        );
      } else if (command.action === 'after-commit') {
        await new SubmitWager(uow).execute(command.input!, command.key!);
        process.send?.({ phase: 'after-commit' });
        await new Promise<void>(() => {});
      } else if (command.action === 'publish') {
        const publisher = new PublishOutbox(uow, transport);
        while ((await publisher.runOne()) !== 'idle') {
          /* Drena apenas a Outbox do schema exclusivo. */
        }
        await close();
      } else if (command.action === 'start') {
        worker = new SqsConsumerWorker(
          new WagerConsumer(uow, transport, new Set(['provider-a'])),
          transport,
          100,
        );
        worker.start();
        process.send?.({ phase: 'started' });
      } else if (command.action === 'sigterm') {
        // Windows não entrega SIGTERM ao processo JS como Unix; exercita o mesmo handler via IPC.
        process.emit('SIGTERM', 'SIGTERM');
      }
    } catch (error) {
      process.send?.({
        phase: 'error',
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      await close();
    }
  },
);
process.send?.({ phase: 'ready' });
