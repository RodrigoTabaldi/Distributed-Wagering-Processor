import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  QueryNotFoundError,
  QueryWallets,
  ReconcileWallet,
} from '../../application/query-wallets.js';
import { InvalidLedgerPageError } from '../../application/ports/repositories.js';
import { infrastructureHttpError } from './infrastructure-error.js';

@Controller()
export class QueryController {
  constructor(
    @Inject(QueryWallets) private readonly queries: QueryWallets,
    @Inject(ReconcileWallet) private readonly reconciliation: ReconcileWallet,
  ) {}
  @Get('wallets/:walletId')
  wallet(@Param('walletId', new ParseUUIDPipe()) id: string) {
    return this.result(() => this.queries.wallet(id.toLowerCase()));
  }
  @Get('wallets/:walletId/ledger')
  ledger(
    @Param('walletId', new ParseUUIDPipe()) id: string,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ) {
    // Rejeita parâmetros repetidos, decimais, vazios e valores acima do máximo; não os arredonda.
    if (
      limit !== undefined &&
      (typeof limit !== 'string' ||
        !/^[1-9]\d{0,2}$/.test(limit) ||
        Number(limit) > 100)
    )
      throw new BadRequestException('limit must be an integer from 1 to 100');
    if (
      cursor !== undefined &&
      (typeof cursor !== 'string' || !cursor || cursor.length > 512)
    )
      throw new BadRequestException('Invalid ledger cursor');
    return this.result(() =>
      this.queries.ledger(id.toLowerCase(), {
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
        ...(cursor !== undefined ? { cursor: cursor as string } : {}),
      }),
    );
  }
  @Get('wagering/transactions/:transactionId')
  transaction(@Param('transactionId', new ParseUUIDPipe()) id: string) {
    return this.result(() => this.queries.transaction(id.toLowerCase()));
  }
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  external(
    @Param('providerId') provider: string,
    @Param('externalTransactionId') external: string,
  ) {
    if (
      !provider.trim() ||
      !external.trim() ||
      provider.length > 255 ||
      external.length > 255
    )
      throw new BadRequestException('Invalid transaction identity');
    return this.result(() =>
      this.queries.externalTransaction(provider, external),
    );
  }
  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', new ParseUUIDPipe()) id: string) {
    return this.result(() => this.reconciliation.execute(id.toLowerCase()));
  }
  private async result<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof QueryNotFoundError)
        throw new NotFoundException('Resource not found');
      if (error instanceof InvalidLedgerPageError)
        throw new BadRequestException('Invalid ledger cursor or limit');
      throw infrastructureHttpError(error, 'query resource');
    }
  }
}
