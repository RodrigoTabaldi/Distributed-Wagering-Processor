// Somente metadados operacionais entram nos logs: nunca saldo, payload, SQL ou credenciais.
export interface TraceContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}
export type TelemetryEvent = TraceContext &
  (
    | { type: 'transaction'; status: string }
    | { type: 'duplicate'; source: 'inbox' | 'idempotency' }
    | { type: 'retry'; source: 'sqs' | 'outbox' | 'reference' }
    | { type: 'dlq' }
    | { type: 'lock_conflict' }
    | { type: 'reconciliation_divergence' }
  );
export interface Telemetry {
  // Opcional: adaptadores podem medir spans sem obrigar o domínio a conhecer OpenTelemetry.
  span?<T>(
    name: 'sql.transaction' | 'sqs.consume',
    operation: () => Promise<T>,
  ): Promise<T>;
  record(event: TelemetryEvent): void;
  duration(source: 'sql' | 'sqs', seconds: number): void;
}
export const TELEMETRY = Symbol('TELEMETRY');
// Testes e consumidores que não configuram observabilidade preservam o contrato original.
export const NOOP_TELEMETRY: Telemetry = {
  record() {},
  duration() {},
};
