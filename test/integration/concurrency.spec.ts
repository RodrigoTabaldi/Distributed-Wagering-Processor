import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from '../../src/application/create-wallet.js';
import { ProcessBet } from '../../src/application/process-bet.js';
import {
  SubmitWager,
  type SubmitWagerInput,
} from '../../src/application/submit-wager.js';
import { Money } from '../../src/domain/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/wager-transaction.js';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { PostgreSqlUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work.js';

interface Message {
  event: 'ready' | 'locked' | 'result' | 'error';
  job?: string;
  pid?: number;
  name?: string;
  result?: {
    status: string;
    balance: { amount: string };
    failureCode?: string;
    transactionId: string;
    idempotentReplay?: boolean;
  };
}
interface Worker {
  process: ChildProcess;
  pid: number;
  wait: (matches: (message: Message) => boolean) => Promise<Message>;
}
const connect = () => MikroORM.init(createOrmConfig('dwp_test'));
let orm: Awaited<ReturnType<typeof connect>>;
let uow: PostgreSqlUnitOfWork;
const children: ChildProcess[] = [];

async function worker(): Promise<Worker> {
  const child = fork(
    fileURLToPath(new URL('../helpers/concurrency-worker.ts', import.meta.url)),
    [],
    {
      execPath: process.execPath,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  children.push(child);
  // O teste mantém até 50 esperas simultâneas; cada espera remove seus listeners ao terminar.
  child.setMaxListeners(64);
  const messages: Message[] = [];
  const listeners = new Set<() => void>();
  child.on('message', (message: Message) => {
    messages.push(message);
    for (const notify of listeners) notify();
  });
  // Timeout só limita falhas: a sincronização depende das mensagens e do lock observado no banco.
  const wait = (matches: (message: Message) => boolean) =>
    new Promise<Message>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Concurrency worker timed out'));
      }, 10000);
      const cleanup = () => {
        clearTimeout(timeout);
        listeners.delete(check);
        child.off('exit', exited);
        child.off('error', failed);
      };
      const check = () => {
        const message = messages.find(matches);
        if (message) {
          cleanup();
          resolve(message);
        }
      };
      const exited = () => {
        cleanup();
        reject(new Error('Concurrency worker exited unexpectedly'));
      };
      const failed = () => {
        cleanup();
        reject(new Error('Concurrency worker could not start'));
      };
      listeners.add(check);
      child.once('exit', exited);
      child.once('error', failed);
      check();
    });
  const ready = await wait((message) => message.event === 'ready');
  return { process: child, pid: ready.pid!, wait };
}
function start(worker: Worker, id: string, job: string, hold = false) {
  worker.process.send({ action: 'bet', transactionId: id, job, hold });
  return worker.wait(
    (message) =>
      message.job === job && ['result', 'error'].includes(message.event),
  );
}

async function seed(amounts: string[]) {
  const wallet = await new CreateWallet(uow).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const transactions = amounts.map((amount) => {
    const id = crypto.randomUUID();
    return WagerTransaction.create({
      id,
      providerId: 'concurrency',
      externalTransactionId: id,
      idempotencyKey: `concurrency:${id}`,
      payloadHash: 'a'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount, currency: 'BRL' }),
      createdAt: new Date(),
    });
  });
  await uow.transaction(async ({ wagers }) => {
    for (const tx of transactions) await wagers.create(tx);
  });
  return { wallet, transactions };
}

// A reconciliação inclui o CREDIT de abertura e todos os débitos, sem usar number para dinheiro.
async function assertBalance(
  walletId: string,
  balance: string,
  version: number,
  debits: string,
) {
  const [row] = await orm.em.fork().execute(
    `SELECT w.balance, w.version,
    (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = w.id AND direction = 'DEBIT') AS debits,
    (SELECT sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)
      FROM wallet_ledger_entries WHERE wallet_id = w.id)::numeric(20,2)::text AS reconstructed
    FROM wallets w WHERE w.id = ?`,
    [walletId],
  );
  expect(row).toEqual({ balance, version, debits, reconstructed: balance });
}

async function waitForBlocked(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await orm.em
      .fork()
      .execute(`SELECT cardinality(pg_blocking_pids(?)) > 0 AS blocked`, [pid]);
    if (row.blocked) return;
    await delay(20);
  }
  throw new Error('Expected worker to wait for a PostgreSQL lock');
}

describe('Wallet concurrency across Bun processes', () => {
  it('allows one debit rollback of a WIN across three processes without negative balance', async () => {
    const { wallet } = await seed([]);
    const source: SubmitWagerInput = {
      providerId: 'rollback-processes',
      externalTransactionId: crypto.randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    };
    await new SubmitWager(uow).execute(source, crypto.randomUUID());
    await new SubmitWager(uow).execute(
      {
        ...source,
        kind: WagerTransactionKind.Bet,
        externalTransactionId: crypto.randomUUID(),
        money: { amount: '100.00', currency: 'BRL' },
      },
      crypto.randomUUID(),
    );
    const workers = await Promise.all([worker(), worker(), worker()]);
    const submit = (index: number, hold = false) => {
      const input: SubmitWagerInput = {
        ...source,
        kind: WagerTransactionKind.Rollback,
        externalTransactionId: crypto.randomUUID(),
        referenceExternalTransactionId: source.externalTransactionId,
      };
      const job = `rollback-${index}`;
      workers[index]!.process.send({
        action: 'submit',
        input,
        key: crypto.randomUUID(),
        job,
        hold,
      });
      return workers[index]!.wait(
        (message) =>
          message.job === job && ['result', 'error'].includes(message.event),
      );
    };
    const first = submit(0, true);
    await workers[0]!.wait((message) => message.event === 'locked');
    const second = submit(1);
    const third = submit(2);
    await Promise.all([
      waitForBlocked(workers[1]!.pid),
      waitForBlocked(workers[2]!.pid),
    ]);
    workers[0]!.process.send({ action: 'release', job: 'rollback-0' });
    const results = await Promise.all([first, second, third]);
    expect(
      results.filter((message) => message.result?.status === 'PROCESSED'),
    ).toHaveLength(1);
    expect(
      results.filter(
        (message) =>
          message.result?.failureCode === 'REFERENCE_ALREADY_ROLLED_BACK',
      ),
    ).toHaveLength(2);
    // Saldo disponível era exatamente 50.00: somente um processo pode retirá-lo.
    await assertBalance(wallet.id, '0.00', 4, '2');
    const [row] = await orm.em
      .fork()
      .execute(
        "SELECT count(*) AS rollbacks FROM wager_transactions WHERE wallet_id = ? AND kind = 'ROLLBACK' AND status = 'PROCESSED'",
        [wallet.id],
      );
    expect(row.rollbacks).toBe('1');
  });
  it('allows only one REFUND of a BET across three independent processes', async () => {
    const { wallet, transactions } = await seed(['25.00']);
    const bet = transactions[0]!;
    await new ProcessBet(uow).execute(bet.id);
    const workers = await Promise.all([worker(), worker(), worker()]);
    const submit = (index: number, hold = false) => {
      const input: SubmitWagerInput = {
        providerId: bet.providerId,
        externalTransactionId: crypto.randomUUID(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: bet.roundId,
        gameId: bet.gameId,
        kind: WagerTransactionKind.Refund,
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.externalTransactionId,
      };
      const job = `refund-${index}`;
      workers[index]!.process.send({
        action: 'submit',
        input,
        key: crypto.randomUUID(),
        job,
        hold,
      });
      return workers[index]!.wait(
        (message) =>
          message.job === job && ['result', 'error'].includes(message.event),
      );
    };
    // As operações possuem IDs e chaves distintos: aqui verificamos unicidade da reversão, não replay.
    const first = submit(0, true);
    await workers[0]!.wait((message) => message.event === 'locked');
    const second = submit(1);
    const third = submit(2);
    await Promise.all([
      waitForBlocked(workers[1]!.pid),
      waitForBlocked(workers[2]!.pid),
    ]);
    workers[0]!.process.send({ action: 'release', job: 'refund-0' });
    const results = await Promise.all([first, second, third]);
    expect(
      results.filter((message) => message.result?.status === 'PROCESSED'),
    ).toHaveLength(1);
    expect(
      results.filter(
        (message) =>
          message.result?.failureCode === 'REFERENCE_ALREADY_REFUNDED',
      ),
    ).toHaveLength(2);
    await assertBalance(wallet.id, '100.00', 3, '1');
    const [row] = await orm.em
      .fork()
      .execute(
        "SELECT count(*) AS refunds FROM wager_transactions WHERE reference_transaction_id = ? AND kind = 'REFUND' AND status = 'PROCESSED'",
        [bet.id],
      );
    expect(row.refunds).toBe('1');
  });
  it('deduplicates 50 submissions distributed across three independent processes', async () => {
    const { wallet } = await seed([]);
    const input: SubmitWagerInput = {
      providerId: 'multi-process-idempotency',
      externalTransactionId: crypto.randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    };
    const key = crypto.randomUUID();
    const workers = await Promise.all([worker(), worker(), worker()]);
    const submit = (w: Worker, job: string, hold = false) => {
      w.process.send({ action: 'submit', job, input, key, hold });
      return w.wait(
        (message) =>
          message.job === job && ['result', 'error'].includes(message.event),
      );
    };
    // O primeiro envio segura o lock; os outros processos disputam a mesma operação antes do commit.
    const first = submit(workers[0]!, 'submit-0', true);
    await workers[0]!.wait((message) => message.event === 'locked');
    const duplicates = Array.from({ length: 49 }, (_, i) =>
      submit(workers[(i + 1) % 3]!, `submit-${i + 1}`),
    );
    await Promise.all([
      waitForBlocked(workers[1]!.pid),
      waitForBlocked(workers[2]!.pid),
    ]);
    workers[0]!.process.send({ action: 'release', job: 'submit-0' });
    const results = await Promise.all([first, ...duplicates]);
    expect(results.every((message) => message.event === 'result')).toBe(true);
    expect(
      results.filter((message) => message.result?.idempotentReplay === false),
    ).toHaveLength(1);
    expect(
      results.filter((message) => message.result?.idempotentReplay === true),
    ).toHaveLength(49);
    expect(
      new Set(results.map((message) => message.result?.transactionId)).size,
    ).toBe(1);
    await assertBalance(wallet.id, '75.00', 2, '1');
    // Um processo recém-iniciado também encontra o resultado: a garantia não depende de memória.
    const restarted = await worker();
    const replay = await submit(restarted, 'after-restart');
    expect(replay.result).toEqual({
      ...results[0]!.result!,
      idempotentReplay: true,
    });
    await assertBalance(wallet.id, '75.00', 2, '1');
  });
  beforeAll(async () => {
    orm = await connect();
    await orm.migrator.up();
    uow = new PostgreSqlUnitOfWork(orm);
  });
  afterEach(async () => {
    // Encerra somente os processos criados pelo teste, inclusive se uma asserção falhar com lock aberto.
    await Promise.all(
      children.splice(0).map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null)
              return resolve();
            child.once('exit', () => resolve());
            child.kill();
          }),
      ),
    );
  });
  afterAll(async () => {
    if (orm) await orm.close();
  });

  it('serializes two competing bets while a third process completes a different wallet', async () => {
    const same = await seed(['80.00', '80.00']);
    const other = await seed(['25.00']);
    const [a, b, c] = await Promise.all([worker(), worker(), worker()]);
    expect(new Set([a.process.pid, b.process.pid, c.process.pid]).size).toBe(3);
    const first = start(a, same.transactions[0]!.id, 'first', true);
    await a.wait(
      (message) => message.event === 'locked' && message.job === 'first',
    );
    const second = start(b, same.transactions[1]!.id, 'second');
    await waitForBlocked(b.pid);
    // A continua segurando a wallet disputada. C deve conseguir COMMIT em outra wallet.
    const independent = await start(
      c,
      other.transactions[0]!.id,
      'independent',
    );
    expect(independent.result?.status).toBe('PROCESSED');
    await assertBalance(other.wallet.id, '75.00', 2, '1');
    a.process.send({ action: 'release', job: 'first' });
    const results = await Promise.all([first, second]);
    expect(
      results
        .map((message) => message.result?.status)
        .sort((left, right) => (left ?? '').localeCompare(right ?? '')),
    ).toEqual(['PROCESSED', 'REJECTED']);
    expect(
      results.find((message) => message.result?.status === 'REJECTED')?.result
        ?.failureCode,
    ).toBe('INSUFFICIENT_BALANCE');
    await assertBalance(same.wallet.id, '20.00', 2, '1');
    const rows = await orm.em.fork().execute(
      'SELECT status, observed_balance FROM wager_transactions WHERE id IN (?, ?) ORDER BY status',
      same.transactions.map((tx) => tx.id),
    );
    expect(rows).toEqual([
      { status: 'PROCESSED', observed_balance: '20.00' },
      { status: 'REJECTED', observed_balance: '20.00' },
    ]);
    // Reentregar os IDs terminais não pode gerar outro débito; replay completo pertence à tarefa 12.
    const retries = await Promise.all(
      same.transactions.map((tx, i) => start([a, b][i]!, tx.id, `retry-${i}`)),
    );
    expect(retries.map((message) => message.name)).toEqual([
      'InvalidTransactionStateError',
      'InvalidTransactionStateError',
    ]);
    await assertBalance(same.wallet.id, '20.00', 2, '1');
  });

  it('prevents lost updates from three simultaneous distinct bets on one wallet', async () => {
    const { wallet, transactions } = await seed(['10.00', '20.00', '30.00']);
    const workers = await Promise.all([worker(), worker(), worker()]);
    const first = start(workers[0]!, transactions[0]!.id, 'one', true);
    await workers[0]!.wait((message) => message.event === 'locked');
    const second = start(workers[1]!, transactions[1]!.id, 'two');
    const third = start(workers[2]!, transactions[2]!.id, 'three');
    await Promise.all([
      waitForBlocked(workers[1]!.pid),
      waitForBlocked(workers[2]!.pid),
    ]);
    workers[0]!.process.send({ action: 'release', job: 'one' });
    const results = await Promise.all([first, second, third]);
    expect(results.map((message) => message.result?.status)).toEqual([
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
    ]);
    await assertBalance(wallet.id, '40.00', 4, '3');
  });
});
