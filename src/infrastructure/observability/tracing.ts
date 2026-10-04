import { AsyncLocalStorage } from 'node:async_hooks';
import { SpanStatusCode, trace, context, type Span } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  NodeTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';

// Tracing é opcional e não contém corpo HTTP, valores monetários, SQL ou credenciais.
export class Tracing {
  private readonly active = new AsyncLocalStorage<Span>();
  private readonly provider: NodeTracerProvider | undefined;
  constructor(processor?: SpanProcessor) {
    if (processor || process.env.OTEL_ENABLED === 'true') {
      this.provider = new NodeTracerProvider({
        resource: resourceFromAttributes({ 'service.name': 'dwp' }),
        spanProcessors: [
          processor ??
            new BatchSpanProcessor(
              new OTLPTraceExporter({
                url:
                  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
                  'http://127.0.0.1:4318/v1/traces',
                timeoutMillis: 2000,
              }),
            ),
        ],
      });
    }
  }
  start(name: string, correlationId?: string): Span | undefined {
    if (!this.provider) return;
    const parent = this.active.getStore();
    return this.provider.getTracer('dwp').startSpan(
      name,
      {
        attributes: correlationId
          ? { 'dwp.correlation_id': correlationId }
          : {},
      },
      parent ? trace.setSpan(context.active(), parent) : context.active(),
    );
  }
  run<T>(span: Span | undefined, operation: () => T): T {
    return span ? this.active.run(span, operation) : operation();
  }
  async span<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const span = this.start(name);
    return this.run(span, async () => {
      try {
        return await operation();
      } catch (error) {
        // Apenas o status é registrado: mensagens de exceção podem conter dados sensíveis.
        span?.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span?.end();
      }
    });
  }
  ids(): { traceId?: string; spanId?: string } {
    const current = this.active.getStore()?.spanContext();
    return current ? { traceId: current.traceId, spanId: current.spanId } : {};
  }
  async shutdown(): Promise<void> {
    await this.provider?.shutdown();
  }
}
