import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Post,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SubmitWager,
  StoredResultUnavailableError,
} from '../../application/submit-wager.js';
import { InvalidBetError } from '../../application/process-bet.js';
import { InvalidWinError } from '../../application/process-win.js';
import { InvalidLossError } from '../../application/process-loss.js';
import { InvalidRefundError } from '../../application/process-refund.js';
import { InvalidRollbackError } from '../../application/process-rollback.js';
import type { Response } from 'express';
import { InvalidMoneyError } from '../../domain/money.js';
import {
  IdempotencyConflictError,
  WagerTransactionStatus,
  InvalidWagerTransactionError,
} from '../../domain/wager-transaction.js';
import { SubmitWagerDto } from './submit-wager.dto.js';

@Controller('wagering/transactions')
export class WagerController {
  constructor(@Inject(SubmitWager) private readonly submitWager: SubmitWager) {}

  @Post()
  @HttpCode(200)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') header: unknown,
    @Res({ passthrough: true }) response: Response,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    const { input, key } = SubmitWagerDto.parse(body, header);
    let result;
    try {
      result = await this.submitWager.execute(
        input,
        key,
        correlationId ? { correlationId } : undefined,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError)
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      if (error instanceof InvalidWagerTransactionError)
        throw new BadRequestException({
          code: 'INVALID_PAYLOAD',
          message: 'Invalid wagering payload',
        });
      if (error instanceof InvalidMoneyError)
        throw new BadRequestException({
          code: 'INVALID_MONEY',
          message: error.message,
        });
      if (
        error instanceof InvalidBetError ||
        error instanceof InvalidWinError ||
        error instanceof InvalidLossError ||
        error instanceof InvalidRefundError ||
        error instanceof InvalidRollbackError
      )
        throw new BadRequestException({
          code: error.reason,
          message: 'Invalid wagering request',
        });
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (
        error instanceof StoredResultUnavailableError ||
        (typeof code === 'string' &&
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
            ].includes(code)))
      )
        throw new ServiceUnavailableException({
          code: 'INFRASTRUCTURE_UNAVAILABLE',
          message: 'Temporarily unable to submit transaction',
        });
      // Falha inesperada não revela SQL, payload ou credenciais ao cliente.
      throw new InternalServerErrorException({
        code: 'INTERNAL_ERROR',
        message: 'Unable to submit transaction',
      });
    }
    // 422 diferencia rejeição financeira de payload inválido e de conflito de idempotência.
    if (result.status === WagerTransactionStatus.Rejected)
      throw new UnprocessableEntityException(result);
    // Referência fora de ordem é aceite pendente (202), sem crédito antecipado.
    if (result.status === WagerTransactionStatus.PendingReference)
      response.status(202);
    return result;
  }
}
