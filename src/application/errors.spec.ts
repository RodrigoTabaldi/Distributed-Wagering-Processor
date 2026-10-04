import { describe, expect, it } from 'bun:test';
import {
  isPermanentInfrastructureFailure,
  PermanentInfrastructureError,
} from './errors.js';

describe('Infrastructure failure classification', () => {
  it.each(['ECONNREFUSED', 'ETIMEDOUT', '40001', '40P01', '55P03'])(
    'keeps %s retryable',
    (code) => {
      expect(isPermanentInfrastructureFailure({ code })).toBe(false);
    },
  );
  it.each(['42P01', '42703', '42883'])(
    'requires a schema correction for %s',
    (code) => {
      expect(isPermanentInfrastructureFailure({ code })).toBe(true);
    },
  );
  it('requires evidence before declaring a failure permanent', () => {
    expect(isPermanentInfrastructureFailure(new Error('Unknown failure'))).toBe(
      false,
    );
    expect(
      isPermanentInfrastructureFailure(new PermanentInfrastructureError()),
    ).toBe(true);
  });
});
