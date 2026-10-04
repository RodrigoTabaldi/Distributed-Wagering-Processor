import { describe, expect, it } from 'bun:test';
import { Money } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from '../domain/wallet-ledger-entry.js';
import {
  FailureCode,
  IdempotencyConflictError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../domain/wager-transaction.js';
import type { OutboxMessage } from '../domain/outbox-message.js';
import type { RepositorySession, UnitOfWork } from './ports/repositories.js';
import { SubmitWager, type SubmitWagerInput } from './submit-wager.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
// Dublê estrito: uma dependência não configurada falha, em vez de esconder uma chamada inesperada.
function stub<T extends object>(methods: Partial<T>): T {
  return new Proxy(methods, {
    get(target, key) {
      if (!(key in target))
        throw new Error(`Unexpected repository call: ${String(key)}`);
      return Reflect.get(target, key);
    },
  }) as T;
}
function fixture(balance = '100.00') {
  const wallet = Wallet.rehydrate({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const transactions = new Map<string, WagerTransaction>();
  const balances = new Map<string, Money>();
  const entries: WalletLedgerEntry[] = [];
  const events: OutboxMessage[] = [];
  const session: RepositorySession = {
    wallets: stub<RepositorySession['wallets']>({
      findByIdForUpdate: async () => wallet,
      save: async () => {},
    }),
    wagers: stub<RepositorySession['wagers']>({
      findById: async (id) => transactions.get(id),
      findByIdempotencyKey: async (key) =>
        [...transactions.values()].find((tx) => tx.idempotencyKey === key),
      findByExternalId: async (provider, external) =>
        [...transactions.values()].find(
          (tx) =>
            tx.providerId === provider && tx.externalTransactionId === external,
        ),
      create: async (tx) => {
        transactions.set(tx.id, tx);
      },
      updateState: async (tx, _expected, _at, observed) => {
        if (observed) balances.set(tx.id, observed);
      },
      findObservedBalance: async (id) => balances.get(id),
      hasProcessedReversal: async (referenceId, kind) =>
        [...transactions.values()].some(
          (tx) =>
            tx.referenceTransactionId === referenceId &&
            tx.kind === kind &&
            tx.status === Status.Processed,
        ),
    }),
    ledger: stub<RepositorySession['ledger']>({
      create: async (entry) => {
        entries.push(entry);
      },
      findByTransaction: async (_wallet, transaction) =>
        entries.find((entry) => entry.transactionId === transaction),
    }),
    outbox: stub<RepositorySession['outbox']>({
      create: async (event) => {
        events.push(event);
      },
    }),
    inbox: stub<RepositorySession['inbox']>({}),
    pendingReferences: stub<RepositorySession['pendingReferences']>({}),
  };
  // Testa regras da aplicação sem banco/fila. Atomicidade e locks são verificados na suíte de integração.
  const uow: UnitOfWork = {
    read: async (operation) => operation(session),
    transaction: async (operation) => operation(session),
  };
  const submit = new SubmitWager(uow);
  const input = (
    kind: SubmitWagerInput['kind'],
    amount = '25.00',
    reference?: string,
  ): SubmitWagerInput => ({
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount).toJSON(),
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  });
  const run = (
    body: SubmitWagerInput,
    key = `key:${body.externalTransactionId}`,
  ) => submit.execute(body, key);
  return { wallet, transactions, entries, events, input, run };
}

describe('Operações financeiras — regras unitárias da aplicação', () => {
  // O mesmo caminho usado por HTTP e SQS deve produzir saldo, versão e ledger coerentes.
  it.each([
    { kind: Kind.Bet, balance: '75.00', direction: LedgerDirection.Debit },
    { kind: Kind.Win, balance: '125.00', direction: LedgerDirection.Credit },
  ])(
    'processa $kind com o lançamento correspondente',
    async ({ kind, balance, direction }) => {
      const f = fixture();
      const result = await f.run(f.input(kind));
      expect(result.status).toBe(Status.Processed);
      expect(result.balance.amount).toBe(balance);
      expect(f.wallet.version).toBe(2);
      expect(f.entries).toHaveLength(1);
      expect(f.entries[0].direction).toBe(direction);
      expect(f.entries[0].isBalanced()).toBe(true);
      expect(f.events).toHaveLength(2);
    },
  );
  it('BET sem saldo rejeita sem alterar saldo, versão ou ledger', async () => {
    const f = fixture('10.00');
    const result = await f.run(f.input(Kind.Bet));
    expect(result.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(result.status).toBe(Status.Rejected);
    expect(f.wallet.balance.toString()).toBe('10.00');
    expect(f.wallet.version).toBe(1);
    expect(f.entries).toHaveLength(0);
    expect(f.events).toHaveLength(1);
  });
  it('LOSS registra o resultado sem movimentação ou nova versão', async () => {
    const f = fixture();
    expect((await f.run(f.input(Kind.Loss))).status).toBe(Status.Processed);
    expect(f.wallet.balance.toString()).toBe('100.00');
    expect(f.wallet.version).toBe(1);
    expect(f.entries).toHaveLength(0);
    expect(f.events.map((event) => event.eventType)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });
  it.each([Kind.Bet, Kind.Win, Kind.Loss])(
    'valor zero em %s não altera saldo ou ledger',
    async (kind) => {
      const f = fixture();
      expect((await f.run(f.input(kind, '0.00'))).status).toBe(
        Status.Processed,
      );
      expect(f.wallet.version).toBe(1);
      expect(f.entries).toHaveLength(0);
    },
  );
  it('REFUND devolve a BET uma vez e rejeita uma segunda devolução', async () => {
    const f = fixture();
    const bet = f.input(Kind.Bet);
    await f.run(bet);
    const refund = await f.run(
      f.input(Kind.Refund, '25.00', bet.externalTransactionId),
    );
    expect(refund.balance.amount).toBe('100.00');
    expect(refund.status).toBe(Status.Processed);
    expect(f.entries[1].direction).toBe(LedgerDirection.Credit);
    const second = await f.run(
      f.input(Kind.Refund, '25.00', bet.externalTransactionId),
    );
    expect(second.failureCode).toBe(FailureCode.ReferenceAlreadyRefunded);
    expect(f.entries).toHaveLength(2);
  });
  it.each([Kind.Refund, Kind.Rollback])(
    '%s fora de ordem aguarda sem mudar a carteira',
    async (kind) => {
      const f = fixture();
      expect(
        (await f.run(f.input(kind, '25.00', 'not-yet-arrived'))).status,
      ).toBe(Status.PendingReference);
      expect(f.wallet.balance.toString()).toBe('100.00');
      expect(f.wallet.version).toBe(1);
      expect(f.entries).toHaveLength(0);
    },
  );
  it.each([Kind.Bet, Kind.Win, Kind.Refund])(
    'ROLLBACK inverte %s e impede uma segunda reversão',
    async (kind) => {
      const f = fixture();
      let original = f.input(kind);
      if (kind === Kind.Refund) {
        const bet = f.input(Kind.Bet);
        await f.run(bet);
        original = f.input(kind, '25.00', bet.externalTransactionId);
      }
      await f.run(original);
      const before = f.wallet.balance;
      const result = await f.run(
        f.input(Kind.Rollback, '25.00', original.externalTransactionId),
      );
      expect(result.status).toBe(Status.Processed);
      expect(result.balance.amount).toBe(
        (kind === Kind.Bet
          ? before.add(brl('25.00'))
          : before.subtract(brl('25.00'))
        ).toString(),
      );
      expect(f.entries.at(-1)?.direction).toBe(
        kind === Kind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit,
      );
      const count = f.entries.length;
      expect(
        (
          await f.run(
            f.input(Kind.Rollback, '25.00', original.externalTransactionId),
          )
        ).failureCode,
      ).toBe(FailureCode.ReferenceAlreadyRolledBack);
      expect(f.entries).toHaveLength(count);
    },
  );
  it('ROLLBACK de prêmio já gasto tem código próprio e não torna saldo negativo', async () => {
    const f = fixture('0.00');
    const win = f.input(Kind.Win);
    await f.run(win);
    await f.run(f.input(Kind.Bet));
    const result = await f.run(
      f.input(Kind.Rollback, '25.00', win.externalTransactionId),
    );
    expect(result.failureCode).toBe(FailureCode.ReversalInsufficientBalance);
    expect(f.wallet.balance.toString()).toBe('0.00');
    expect(f.entries).toHaveLength(2);
  });
  it.each([Kind.Refund, Kind.Rollback])(
    '%s rejeita valor diferente da referência sem novo lançamento',
    async (kind) => {
      const f = fixture();
      const bet = f.input(Kind.Bet);
      await f.run(bet);
      expect(
        (await f.run(f.input(kind, '20.00', bet.externalTransactionId)))
          .failureCode,
      ).toBe(FailureCode.ReferenceAmountMismatch);
      expect(f.wallet.balance.toString()).toBe('75.00');
      expect(f.entries).toHaveLength(1);
    },
  );
  it('replay retorna o saldo original mesmo depois de outra operação', async () => {
    const f = fixture();
    const bet = f.input(Kind.Bet);
    const original = await f.run(bet, 'same-key');
    await f.run(f.input(Kind.Win, '10.00'));
    const replay = await f.run(bet, 'same-key');
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(f.wallet.balance.toString()).toBe('85.00');
    expect(f.entries).toHaveLength(2);
    expect(f.events).toHaveLength(4);
  });
  it('mesma chave com outro payload gera conflito e preserva o resultado original', async () => {
    const f = fixture();
    const bet = f.input(Kind.Bet);
    await f.run(bet, 'same-key');
    const failure = await f
      .run({ ...bet, money: brl('26.00').toJSON() }, 'same-key')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdempotencyConflictError);
    expect(f.wallet.balance.toString()).toBe('75.00');
    expect(f.entries).toHaveLength(1);
    expect(f.events).toHaveLength(2);
  });
});
