import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  Inject,
  Post,
} from '@nestjs/common';
import {
  CreateWallet,
  type CreateWalletResult,
} from '../../application/create-wallet.js';
import { WalletAlreadyExistsError } from '../../application/errors.js';
import { InvalidMoneyError } from '../../domain/money.js';
import { CreateWalletDto } from './create-wallet.dto.js';
import { infrastructureHttpError } from './infrastructure-error.js';

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
      throw infrastructureHttpError(error, 'create wallet');
    }
  }
}
