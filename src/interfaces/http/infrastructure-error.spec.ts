import { describe, expect, it } from 'bun:test';
import { infrastructureHttpError } from './infrastructure-error.js';

describe('Contrato HTTP de falhas técnicas', () => {
  // O cliente pode repetir indisponibilidades; bugs não devem aparecer como erros financeiros.
  it.each([
    '08006',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    '53300',
    '57P01',
    '40001',
    '40P01',
    '55P03',
  ])('responde 503 para %s sem revelar dados do driver', (code) => {
    const error = infrastructureHttpError(
      { code, message: 'password=secret SQL SELECT balance' },
      'query resource',
    );
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({
      code: 'INFRASTRUCTURE_UNAVAILABLE',
      message: 'Temporarily unable to query resource',
    });
  });
  it('responde 500 para um erro inesperado sem expor sua mensagem', () => {
    const error = infrastructureHttpError(
      new Error('secret'),
      'submit transaction',
    );
    expect(error.getStatus()).toBe(500);
    expect(JSON.stringify(error.getResponse())).not.toContain('secret');
  });
  it('permite sinalizar explicitamente um resultado temporariamente indisponível', () => {
    expect(
      infrastructureHttpError(
        new Error(),
        'submit transaction',
        true,
      ).getStatus(),
    ).toBe(503);
  });
});
