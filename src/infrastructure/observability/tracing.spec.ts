import { describe, expect, it } from 'bun:test';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { SpanStatusCode } from '@opentelemetry/api';
import { Tracing } from './tracing.js';

describe('Tracing opcional e sem dados financeiros', () => {
  it('mantém SQL como filho do HTTP e encerra spans com erro preservando a exceção', async () => {
    // Exportador real em memória testa o SDK, sem depender de um coletor externo.
    const exporter = new InMemorySpanExporter();
    const tracing = new Tracing(new SimpleSpanProcessor(exporter));
    try {
      const parent = tracing.start('http.request', 'correlation-test')!;
      const failure = new Error('payload secreto');
      expect(
        tracing.run(parent, () =>
          tracing.span('sql.transaction', async () => {
            throw failure;
          }),
        ),
      ).rejects.toBe(failure);
      parent.end();
      const [sql, http] = exporter.getFinishedSpans();
      expect(sql!.parentSpanContext?.spanId).toBe(http!.spanContext().spanId);
      expect(sql!.status.code).toBe(SpanStatusCode.ERROR);
      expect(sql!.events).toEqual([]);
      expect(JSON.stringify(sql!.attributes)).not.toContain('secreto');
      expect(http!.attributes).toEqual({
        'dwp.correlation_id': 'correlation-test',
      });
    } finally {
      await tracing.shutdown();
    }
  });
});
