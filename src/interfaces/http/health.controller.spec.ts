import { describe, expect, it, mock } from 'bun:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller.js';

describe('Health — vivo e pronto são condições diferentes', () => {
  it('liveness não consulta dependências indisponíveis', () => {
    const ready = mock(async () => ({ postgres: false, sqs: false }));
    expect(new HealthController({ ready }).live()).toEqual({ status: 'up' });
    expect(ready).not.toHaveBeenCalled();
  });
  it.each([
    { postgres: false, sqs: true },
    { postgres: true, sqs: false },
    { postgres: false, sqs: false },
  ])(
    'readiness falha quando uma dependência está indisponível: %j',
    async (checks) => {
      const controller = new HealthController({ ready: async () => checks });
      const failure = await controller.ready().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ServiceUnavailableException);
      expect(controller.live()).toEqual({ status: 'up' });
    },
  );
  it('readiness exige PostgreSQL e SQS disponíveis', async () => {
    expect(
      await new HealthController({
        ready: async () => ({ postgres: true, sqs: true }),
      }).ready(),
    ).toEqual({ status: 'up', checks: { postgres: true, sqs: true } });
  });
});
