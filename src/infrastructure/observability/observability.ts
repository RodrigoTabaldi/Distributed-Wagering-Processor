import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  ConsoleLogger,
  Global,
  Inject,
  Injectable,
  Module,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  TELEMETRY,
  type Telemetry,
  type TelemetryEvent,
  type TraceContext,
} from '../../application/ports/telemetry.js';

const buckets = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30];
const statuses = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
];
const counterNames = {
  transaction: 'dwp_transactions_total',
  duplicate: 'dwp_duplicates_total',
  retry: 'dwp_retries_total',
  dlq: 'dwp_dlq_messages_total',
  lock_conflict: 'dwp_lock_conflicts_total',
  reconciliation_divergence: 'dwp_reconciliation_divergences_total',
} as const;

@Injectable()
export class Observability implements Telemetry {
  private readonly context = new AsyncLocalStorage<TraceContext>();
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<
    string,
    { count: number; sum: number; buckets: number[] }
  >();
  private readonly logger = new ConsoleLogger('Telemetry', {
    json: true,
    colors: false,
  });
  run<T>(context: TraceContext, operation: () => T): T {
    return this.context.run(context, operation);
  }
  record(event: TelemetryEvent): void {
    // Labels são conjuntos pequenos e fixos. IDs ficam nos logs, nunca nos labels das métricas.
    const labels =
      event.type === 'transaction'
        ? `{status="${statuses.includes(event.status) ? event.status : 'UNKNOWN'}"}`
        : event.type === 'duplicate' || event.type === 'retry'
          ? `{source="${event.source}"}`
          : '';
    const key = `${counterNames[event.type]}${labels}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    const context: Record<string, unknown> = {
      ...this.context.getStore(),
      ...event,
    };
    const safe: Record<string, string> = { event: event.type };
    // Lista permitida protege até chamadas que recebam propriedades extras em runtime.
    for (const field of [
      'correlationId',
      'messageId',
      'transactionId',
      'walletId',
      'providerId',
      'status',
      'source',
    ] as const) {
      const value = context[field];
      if (typeof value === 'string') safe[field] = value.slice(0, 255);
    }
    // Uma falha na saída de logs não deve transformar commit financeiro confirmado em erro HTTP.
    try {
      this.logger.log(safe);
    } catch {
      /* Métricas continuam disponíveis no endpoint. */
    }
  }
  duration(source: 'sql' | 'sqs', seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const stats = this.durations.get(source) ?? {
      count: 0,
      sum: 0,
      buckets: buckets.map(() => 0),
    };
    stats.count++;
    stats.sum += seconds;
    buckets.forEach((bound, index) => {
      if (seconds <= bound) stats.buckets[index]++;
    });
    this.durations.set(source, stats);
  }
  metrics(outboxLagSeconds: number): string {
    // Formato Prometheus 0.0.4; contadores são locais a cada instância/processo.
    const lines: string[] = [];
    for (const name of Object.values(counterNames)) {
      lines.push(
        `# HELP ${name} Operational event count`,
        `# TYPE ${name} counter`,
      );
      const values = [...this.counters].filter(
        ([key]) => key === name || key.startsWith(`${name}{`),
      );
      if (!values.length) lines.push(`${name} 0`);
      else for (const [key, count] of values) lines.push(`${key} ${count}`);
    }
    const name = 'dwp_processing_duration_seconds';
    lines.push(
      `# HELP ${name} Processing duration including SQL lock waits`,
      `# TYPE ${name} histogram`,
    );
    for (const [source, stats] of this.durations) {
      buckets.forEach((bound, index) =>
        lines.push(
          `${name}_bucket{source="${source}",le="${bound}"} ${stats.buckets[index]}`,
        ),
      );
      lines.push(
        `${name}_bucket{source="${source}",le="+Inf"} ${stats.count}`,
        `${name}_sum{source="${source}"} ${stats.sum}`,
        `${name}_count{source="${source}"} ${stats.count}`,
      );
    }
    lines.push(
      '# HELP dwp_outbox_lag_seconds Age of oldest unpublished event',
      '# TYPE dwp_outbox_lag_seconds gauge',
      `dwp_outbox_lag_seconds ${Math.max(0, outboxLagSeconds)}`,
    );
    return `${lines.join('\n')}\n`;
  }
}

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(@Inject(TELEMETRY) private readonly telemetry: Observability) {}
  use(request: Request, response: Response, next: NextFunction): void {
    const header = request.headers['x-correlation-id'];
    // Evita texto arbitrário no identificador; devolve o ID para facilitar diagnóstico.
    const correlationId =
      typeof header === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(header)
        ? header
        : randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    this.telemetry.run({ correlationId }, next);
  }
}
@Global()
@Module({
  providers: [
    { provide: TELEMETRY, useClass: Observability },
    CorrelationMiddleware,
  ],
  exports: [TELEMETRY, CorrelationMiddleware],
})
export class ObservabilityModule {}
