import { expect, it } from 'bun:test';
import {
  ReprocessPendingReferences,
  type ReferenceRetryResult,
} from '../../application/reprocess-pending-references.js';
import { PendingReferenceWorker } from './pending-reference.worker.js';

it('does not overlap polls and waits for active work during shutdown', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  class ControlledRetry extends ReprocessPendingReferences {
    override async runDue(): Promise<ReferenceRetryResult[]> {
      calls++;
      await gate;
      return [];
    }
  }
  const retry = new ControlledRetry({
    read: async () => {
      throw new Error('Unused in lifecycle test');
    },
    transaction: async () => {
      throw new Error('Unused in lifecycle test');
    },
  });
  const worker = new PendingReferenceWorker(retry);
  const first = worker.tick();
  expect(worker.tick()).toBe(first);
  expect(calls).toBe(1);
  let stopped = false;
  const shutdown = worker.beforeApplicationShutdown().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  // Encerrar o servidor aguarda a tentativa já iniciada, preservando o commit financeiro.
  release();
  await shutdown;
  expect(stopped).toBe(true);
  await worker.tick();
  expect(calls).toBe(1);
});
