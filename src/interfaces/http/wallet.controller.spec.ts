import { describe, expect, it } from 'bun:test';
import { HttpException } from '@nestjs/common';
import { CreateWallet } from '../../application/create-wallet.js';
import type { UnitOfWork } from '../../application/ports/repositories.js';
import { WalletController } from './wallet.controller.js';

// Testes focados no mapeamento HTTP; a persistência é testada com banco real em integração.
describe('WalletController errors', () => {
  it.each([
    {
      code: 'ECONNREFUSED',
      status: 503,
      responseCode: 'INFRASTRUCTURE_UNAVAILABLE',
    },
    { code: '40001', status: 503, responseCode: 'INFRASTRUCTURE_UNAVAILABLE' },
    { code: 'XX000', status: 500, responseCode: 'INTERNAL_ERROR' },
  ])(
    'maps infrastructure failure $code without leaking details',
    async ({ code, status, responseCode }) => {
      const failure = async (): Promise<never> => {
        throw Object.assign(new Error('private SQL and credentials'), { code });
      };
      const unitOfWork: UnitOfWork = { read: failure, transaction: failure };
      const controller = new WalletController(new CreateWallet(unitOfWork));
      let caught: unknown;
      try {
        await controller.create({
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '1.00', currency: 'BRL' },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HttpException);
      const error = caught as HttpException;
      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toMatchObject({ code: responseCode });
      expect(JSON.stringify(error.getResponse())).not.toContain('private');
    },
  );
});
