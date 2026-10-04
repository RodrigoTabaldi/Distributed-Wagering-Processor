import { describe, expect, it } from 'bun:test';
import { referenceRetryDelay } from './reference-retry-policy.js';

describe('reference retry backoff', () => {
  // Esperar cada vez mais evita consultar continuamente uma referência que ainda não chegou.
  it('doubles the delay and caps it at one minute', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(referenceRetryDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
  });
  it.each([-1, 0.5, NaN, Infinity])(
    'rejects invalid attempt count %s',
    (attempts) => {
      expect(() => referenceRetryDelay(attempts)).toThrow();
    },
  );
});
