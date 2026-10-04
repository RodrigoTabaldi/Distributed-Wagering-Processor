import { BadRequestException } from '@nestjs/common';
import {
  WagerRequest,
  InvalidWagerRequestError,
} from '../validation/wager-request.js';
// HTTP traduz a validação compartilhada para seu status de transporte; SQS usa a mesma validação.
export class SubmitWagerDto {
  static parse(body: unknown, header: unknown) {
    try {
      return WagerRequest.parse(body, header);
    } catch (error) {
      if (!(error instanceof InvalidWagerRequestError)) throw error;
      throw new BadRequestException({
        code: error.code,
        message:
          error.code === 'INVALID_IDEMPOTENCY_KEY'
            ? 'A non-empty Idempotency-Key header is required'
            : 'Expected a valid wagering transaction payload',
      });
    }
  }
}
