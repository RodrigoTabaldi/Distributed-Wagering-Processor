import { deepStrictEqual } from 'node:assert';
import type { MikroORM } from '@mikro-orm/postgresql';

export async function assertFinancialConsistency(orm: MikroORM): Promise<void> {
  // Auditoria independente do domínio: NUMERIC do PostgreSQL reconstrói todas as wallets da suíte.
  // Inclui saldo zero, OPENING, créditos e débitos; não converte dinheiro para number.
  const mismatches = await orm.em.fork().execute<{ id: string }[]>(
    `SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     GROUP BY w.id HAVING w.balance <> COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
      OR w.balance < 0`,
  );
  deepStrictEqual(
    mismatches,
    [],
    'Wallet balances must equal their immutable ledger',
  );
}
