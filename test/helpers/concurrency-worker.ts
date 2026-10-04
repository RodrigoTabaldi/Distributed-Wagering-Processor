import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessBet } from '../../src/application/process-bet.js';
import {
  SubmitWager,
  type SubmitWagerInput,
} from '../../src/application/submit-wager.js';
import type { UnitOfWork } from '../../src/application/ports/repositories.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';

// Cada worker é um processo Bun com conexão própria: nenhum lock em memória é compartilhado.
const orm = await MikroORM.init({
  ...createOrmConfig('dwp_test'),
  pool: { min: 1, max: 1 },
});
const uow = new PostgreSqlUnitOfWork(orm);
const [connection] = await orm.em
  .fork()
  .execute('SELECT pg_backend_pid() AS pid');
const releases = new Map<string, () => void>();

interface Command {
  action: 'bet' | 'submit' | 'release';
  job: string;
  transactionId?: string;
  hold?: boolean;
  input?: SubmitWagerInput;
  key?: string;
}

process.on('message', (command: Command) => {
  if (command.action === 'release') {
    releases.get(command.job)?.();
    return;
  }
  void run(command);
});

async function run(command: Command): Promise<void> {
  let held = false;
  // A barreira de teste pausa DEPOIS do lock real, sem alterar as regras financeiras.
  // Permite observar outro processo esperando no PostgreSQL, sem depender de um sleep.
  const controlled: UnitOfWork = {
    read: (operation) => uow.read(operation),
    transaction: (operation) =>
      uow.transaction((session) => {
        const wallets = new Proxy(session.wallets, {
          get(target, property) {
            if (property === 'findByIdForUpdate')
              return async (id: string) => {
                const wallet = await target.findByIdForUpdate(id);
                if (command.hold && !held) {
                  held = true;
                  const gate = new Promise<void>((resolve) =>
                    releases.set(command.job, resolve),
                  );
                  process.send?.({ event: 'locked', job: command.job });
                  await gate;
                  releases.delete(command.job);
                }
                return wallet;
              };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return operation({ ...session, wallets });
      }),
  };
  try {
    const result =
      command.action === 'submit'
        ? await new SubmitWager(controlled).execute(
            command.input!,
            command.key!,
          )
        : await new ProcessBet(controlled).execute(command.transactionId!);
    process.send?.({ event: 'result', job: command.job, result });
  } catch (error) {
    // Envia somente a classe do erro; não transporta SQL ou credenciais pelo canal de teste.
    process.send?.({
      event: 'error',
      job: command.job,
      name: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

process.send?.({ event: 'ready', pid: connection.pid });
