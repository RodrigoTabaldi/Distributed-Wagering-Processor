import { describe, expect, it, mock } from 'bun:test';
import {
  QueryNotFoundError,
  ReconcileWallet,
  type ReconciliationReader,
} from './query-wallets.js';

describe('Reconciliação — diagnóstico sem correção', () => {
  it.each([
    { stored: '0.00', calculated: '0.00', difference: '0.00', count: 0 },
    { stored: '100.10', calculated: '100.10', difference: '0.00', count: 150 },
    { stored: '100.10', calculated: '90.00', difference: '10.10', count: 2 },
    { stored: '90.00', calculated: '100.10', difference: '-10.10', count: 2 },
    { stored: '0.00', calculated: '-10.00', difference: '10.00', count: 1 },
  ])(
    'compara exatamente $stored com $calculated',
    async ({ stored, calculated, difference, count }) => {
      const snapshot = {
        walletId: 'wallet-1',
        storedBalance: { amount: stored, currency: 'BRL' },
        calculatedBalance: { amount: calculated, currency: 'BRL' },
        checkedEntries: count,
      };
      const reader: ReconciliationReader = { snapshot: async () => snapshot };
      const record = mock(() => {});
      const result = await new ReconcileWallet(reader, {
        record,
        duration() {},
      }).execute('wallet-1');
      expect(result.difference.amount).toBe(difference);
      expect(result.consistent).toBe(difference === '0.00');
      expect(result.checkedEntries).toBe(count);
      expect(snapshot.storedBalance.amount).toBe(stored);
      // Só divergências geram o evento que alimenta log e contador; nenhum método de escrita existe.
      expect(record).toHaveBeenCalledTimes(difference === '0.00' ? 0 : 1);
    },
  );
  it('distingue wallet inexistente de wallet vazia', async () => {
    return expect(
      new ReconcileWallet({ snapshot: async () => undefined }).execute(
        'missing',
      ),
    ).rejects.toBeInstanceOf(QueryNotFoundError);
  });
});
