import { BadRequestException } from '@nestjs/common';
import type { MoneyProps } from '../../domain/money.js';
import type { CreateWalletInput } from '../../application/create-wallet.js';

// DTO descreve o corpo HTTP. O parser valida JSON desconhecido antes de chamar a aplicação.
export class CreateWalletDto implements CreateWalletInput {
  private constructor(
    public readonly playerId: string,
    public readonly initialBalance: MoneyProps,
  ) {}

  static parse(body: unknown): CreateWalletDto {
    const invalid = (): never => {
      throw new BadRequestException({
        code: 'INVALID_PAYLOAD',
        message:
          'Expected a UUID playerId and initialBalance with string amount and currency',
      });
    };
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return invalid();
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) => !['playerId', 'initialBalance'].includes(key),
      )
    )
      return invalid();
    if (
      typeof input.playerId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        input.playerId,
      ) ||
      input.playerId.trim() !== input.playerId
    )
      return invalid();
    if (
      !input.initialBalance ||
      typeof input.initialBalance !== 'object' ||
      Array.isArray(input.initialBalance)
    )
      return invalid();
    const balance = input.initialBalance as Record<string, unknown>;
    if (
      Object.keys(balance).some(
        (key) => !['amount', 'currency'].includes(key),
      ) ||
      typeof balance.amount !== 'string' ||
      typeof balance.currency !== 'string'
    )
      return invalid();
    // PostgreSQL trata UUIDs sem diferença de maiúsculas; normalizamos também a resposta.
    return new CreateWalletDto(input.playerId.toLowerCase(), {
      amount: balance.amount,
      currency: balance.currency,
    });
  }
}
