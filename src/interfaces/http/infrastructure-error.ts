import {
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';

const retryableCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  '40001',
  '40P01',
  '55P03',
]);
// Mesmo contrato para todas as entradas HTTP: o provedor não precisa interpretar o texto do driver.
export function infrastructureHttpError(
  error: unknown,
  action: string,
  transient = false,
) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  if (
    transient ||
    (typeof code === 'string' &&
      (code.startsWith('08') || retryableCodes.has(code)))
  )
    return new ServiceUnavailableException({
      code: 'INFRASTRUCTURE_UNAVAILABLE',
      message: `Temporarily unable to ${action}`,
    });
  // Nunca transmite SQL, stack, credenciais ou payload financeiro na resposta.
  return new InternalServerErrorException({
    code: 'INTERNAL_ERROR',
    message: `Unable to ${action}`,
  });
}
