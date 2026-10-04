// Número de tentativas e tempo são number; dinheiro continua exclusivamente Money/string.
export const REFERENCE_RETRY_POLICY = Object.freeze({
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  maxAttempts: 20,
  ttlMs: 30 * 60 * 1000,
  batchSize: 25,
  pollIntervalMs: 1000,
});

export function referenceRetryDelay(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 0)
    throw new Error('Invalid reference retry attempts');
  // Limita o expoente antes do cálculo para impedir overflow de números de controle.
  return Math.min(
    REFERENCE_RETRY_POLICY.initialDelayMs * 2 ** Math.min(attempts, 16),
    REFERENCE_RETRY_POLICY.maxDelayMs,
  );
}
