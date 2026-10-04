import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import type {
  ReconciliationReader,
  ReconciliationSnapshot,
} from '../../application/query-wallets.js';

@Injectable()
export class PostgreSqlReconciliationReader implements ReconciliationReader {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
  async snapshot(
    walletId: string,
  ): Promise<ReconciliationSnapshot | undefined> {
    // Uma única instrução SELECT enxerga wallet e ledger no MESMO snapshot do PostgreSQL.
    // SUM usa NUMERIC exato e inclui todo o histórico, independentemente da paginação da API.
    const rows = await this.orm.em.fork().execute<
      {
        walletId: string;
        currency: string;
        stored: string;
        calculated: string;
        count: string;
      }[]
    >(
      `SELECT w.id AS "walletId", w.currency, w.balance::text AS stored,
        COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS calculated,
        COUNT(l.id)::text AS count
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return undefined;
    const checkedEntries = Number(row.count);
    if (!Number.isSafeInteger(checkedEntries))
      throw new Error('Ledger count exceeds safe integer range');
    return {
      walletId: row.walletId,
      storedBalance: { amount: row.stored, currency: row.currency },
      calculatedBalance: { amount: row.calculated, currency: row.currency },
      checkedEntries,
    };
  }
}
