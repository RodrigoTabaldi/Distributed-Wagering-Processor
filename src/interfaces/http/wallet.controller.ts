import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  Inject,
  InternalServerErrorException,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CreateWallet,
  type CreateWalletResult,
} from '../../application/create-wallet.js';
import { WalletAlreadyExistsError } from '../../application/errors.js';
import { InvalidMoneyError } from '../../domain/money.js';
import { CreateWalletDto } from './create-wallet.dto.js';

@Controller('wallets')
export class WalletController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
  ) {}

  // POST responde 201 por padrão no NestJS; regras financeiras ficam no caso de uso.
  @Post()
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<CreateWalletResult> {
    const input = CreateWalletDto.parse(body);
    try {
      return await this.createWallet.execute(input, correlationId);
    } catch (error) {
      if (error instanceof InvalidMoneyError)
        throw new BadRequestException({
          code: 'INVALID_MONEY',
          message: error.message,
        });
      if (error instanceof WalletAlreadyExistsError)
        throw new ConflictException({
          code: 'WALLET_ALREADY_EXISTS',
          message: error.message,
        });
      // Uma indisponibilidade transitória não deve parecer rejeição de negócio.
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (
        typeof code === 'string' &&
        (code.startsWith('08') ||
          [
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
          ].includes(code))
      ) {
        throw new ServiceUnavailableException({
          code: 'INFRASTRUCTURE_UNAVAILABLE',
          message: 'Temporarily unable to create wallet',
        });
      }
      // Não expõe SQL, credenciais ou payload financeiro no erro HTTP ou log padrão.
      throw new InternalServerErrorException({
        code: 'INTERNAL_ERROR',
        message: 'Unable to create wallet',
      });
    }
  }
}
