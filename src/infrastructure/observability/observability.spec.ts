import { describe, expect, it, spyOn } from 'bun:test';
import { Observability } from './observability.js';
import type { TelemetryEvent } from '../../application/ports/telemetry.js';

describe('Observabilidade — logs seguros e métricas operacionais', () => {
  it('emite JSON correlacionado com campos permitidos e descarta payload, saldo e segredo', () => {
    const lines: string[] = [];
    const output = spyOn(process.stdout, 'write').mockImplementation(
      (chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      },
    );
    try {
      const telemetry = new Observability();
      telemetry.run({ correlationId: 'trace-1' }, () =>
        telemetry.record({
          type: 'transaction',
          status: 'PROCESSED',
          messageId: 'msg-1',
          transactionId: 'tx-1',
          walletId: 'wallet-1',
          providerId: 'provider-a',
          password: 'secret-value',
          balance: '999.99',
          payload: { amount: '123.45' },
        } as TelemetryEvent),
      );
      const log = JSON.parse(lines.join(''));
      expect(log.message).toEqual({
        event: 'transaction',
        correlationId: 'trace-1',
        messageId: 'msg-1',
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        providerId: 'provider-a',
        status: 'PROCESSED',
      });
      expect(lines.join('')).not.toContain('secret-value');
      expect(lines.join('')).not.toContain('999.99');
      expect(telemetry.metrics(3)).not.toContain('wallet-1');
    } finally {
      output.mockRestore();
    }
  });
  it('expõe contadores, lag e histograma cumulativo sem usar IDs como labels', () => {
    const output = spyOn(process.stdout, 'write').mockImplementation(
      () => true,
    );
    try {
      const telemetry = new Observability();
      for (const event of [
        { type: 'transaction', status: 'REJECTED' },
        { type: 'duplicate', source: 'inbox' },
        { type: 'retry', source: 'sqs' },
        { type: 'retry', source: 'outbox' },
        { type: 'retry', source: 'reference' },
        { type: 'dlq' },
        { type: 'lock_conflict' },
        { type: 'reconciliation_divergence' },
      ] as TelemetryEvent[])
        telemetry.record(event);
      telemetry.duration('sql', 0.05);
      telemetry.duration('sql', 0.5);
      telemetry.duration('sql', NaN);
      const metrics = telemetry.metrics(12);
      expect(metrics).toContain('dwp_transactions_total{status="REJECTED"} 1');
      expect(metrics).toContain('dwp_duplicates_total{source="inbox"} 1');
      for (const source of ['sqs', 'outbox', 'reference'])
        expect(metrics).toContain(`dwp_retries_total{source="${source}"} 1`);
      expect(metrics).toContain('dwp_dlq_messages_total 1');
      expect(metrics).toContain('dwp_lock_conflicts_total 1');
      expect(metrics).toContain('dwp_reconciliation_divergences_total 1');
      expect(metrics).toContain('dwp_outbox_lag_seconds 12');
      expect(metrics).toContain(
        'dwp_processing_duration_seconds_bucket{source="sql",le="0.05"} 1',
      );
      expect(metrics).toContain(
        'dwp_processing_duration_seconds_bucket{source="sql",le="0.5"} 2',
      );
      expect(metrics).toContain(
        'dwp_processing_duration_seconds_bucket{source="sql",le="+Inf"} 2',
      );
    } finally {
      output.mockRestore();
    }
  });
  it('falha na escrita de log não altera o resultado da aplicação', () => {
    const output = spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('log output unavailable');
    });
    try {
      const telemetry = new Observability();
      expect(() => telemetry.record({ type: 'dlq' })).not.toThrow();
      expect(telemetry.metrics(0)).toContain('dwp_dlq_messages_total 1');
    } finally {
      output.mockRestore();
    }
  });
});
