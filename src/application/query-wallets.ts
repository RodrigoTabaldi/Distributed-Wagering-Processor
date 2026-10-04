import type { MoneyProps } from '../domain/money.js';
import { Money } from '../domain/money.js';
import type { LedgerPageOptions, UnitOfWork } from './ports/repositories.js';
import { NOOP_TELEMETRY, type Telemetry } from './ports/telemetry.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';

export class QueryNotFoundError extends Error {}
export interface ReconciliationSnapshot {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  checkedEntries: number;
}
// O adapter garante uma fotografia consistente, sem misturar dados de commits diferentes.
export interface ReconciliationReader {
  snapshot(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}
export const RECONCILIATION_READER = Symbol('RECONCILIATION_READER');

export class QueryWallets {
  constructor(private readonly uow: UnitOfWork) {}
  async wallet(id: string) {
    return this.uow.read(async ({ wallets }) => {
      const wallet = await wallets.findById(id);
      if (!wallet) throw new QueryNotFoundError();
      return {
        walletId: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
        createdAt: wallet.createdAt.toISOString(),
        updatedAt: wallet.updatedAt.toISOString(),
      };
    });
  }
  async ledger(id: string, options: LedgerPageOptions) {
    return this.uow.read(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(id))) throw new QueryNotFoundError();
      const page = await ledger.findByWallet(id, options);
      // Campos #privados não são serializados automaticamente; o contrato é explícito.
      return {
        walletId: id,
        entries: page.entries.map((entry) => ({
          id: entry.id,
          walletId: entry.walletId,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor ?? null,
      };
    });
  }
  async transaction(id: string) {
    return this.uow.read(async ({ wagers }) =>
      transactionView(await wagers.findById(id)),
    );
  }
  async externalTransaction(providerId: string, externalId: string) {
    return this.uow.read(async ({ wagers }) =>
      transactionView(await wagers.findByExternalId(providerId, externalId)),
    );
  }
}
function transactionView(tx: WagerTransaction | undefined) {
  if (!tx) throw new QueryNotFoundError();
  // Não expomos hash e chave de idempotência: são detalhes internos da deduplicação.
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export class ReconcileWallet {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {}
  async execute(walletId: string) {
    const snapshot = await this.reader.snapshot(walletId);
    if (!snapshot) throw new QueryNotFoundError();
    const stored = Money.from(snapshot.storedBalance);
    // Um histórico corrompido pode ter débitos sem o crédito de abertura. Valores negativos
    // são permitidos no cálculo interno, embora Money.from rejeite negativos na entrada externa.
    const calculated = snapshot.calculatedBalance.amount.startsWith('-')
      ? Money.from({
          ...snapshot.calculatedBalance,
          amount: snapshot.calculatedBalance.amount.slice(1),
        }).negate()
      : Money.from(snapshot.calculatedBalance);
    // Diferença = saldo armazenado - saldo calculado; positivo indica dinheiro a mais na wallet.
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();
    if (!consistent)
      this.telemetry.record({ type: 'reconciliation_divergence', walletId });
    // Diagnóstico somente: nenhuma escrita ou correção automática é realizada.
    return { ...snapshot, difference: difference.toJSON(), consistent };
  }
}
