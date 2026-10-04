import { createHash, randomUUID } from 'node:crypto';
import { Money, type MoneyProps } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import { WagerTransaction } from '../domain/wager-transaction.js';
import { WalletAlreadyExistsError } from './errors.js';
import type { UnitOfWork } from './ports/repositories.js';
import { enqueueWagerEvents } from './persist-wager-outcome.js';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}
export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

// Caso de uso coordena domínio e repositories; não depende de NestJS ou do ORM.
export class CreateWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(
    input: CreateWalletInput,
    correlationId?: string,
  ): Promise<CreateWalletResult> {
    // Money valida escala, moeda, sinal e limite antes de iniciar qualquer gravação.
    const initialBalance = Money.from(input.initialBalance);
    return this.unitOfWork.transaction(async (session) => {
      const { wallets, wagers, ledger } = session;
      if (await wallets.exists(input.playerId, initialBalance.currency))
        throw new WalletAlreadyExistsError();
      const at = new Date();
      const walletId = randomUUID();
      const transactionId = randomUUID();
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId: input.playerId,
        initialBalance,
        at,
        opening: { entryId: randomUUID(), transactionId },
      });
      await wallets.create(wallet);
      if (openingEntry) {
        // OPENING só nasce internamente; nunca usamos dados do chamador para identificar o provedor.
        // Campos ordenados e valores normalizados dão um hash estável ao payload interno.
        const payload = {
          kind: 'OPENING',
          money: initialBalance.toJSON(),
          playerId: wallet.playerId,
          walletId,
        };
        const opening = WagerTransaction.createOpening({
          id: transactionId,
          providerId: '__internal__',
          externalTransactionId: transactionId,
          idempotencyKey: `opening:${transactionId}`,
          payloadHash: createHash('sha256')
            .update(JSON.stringify(payload))
            .digest('hex'),
          walletId,
          playerId: wallet.playerId,
          roundId: `opening:${walletId}`,
          gameId: '__opening__',
          money: initialBalance,
          createdAt: at,
          // A abertura mantém o identificador da requisição nos logs e eventos derivados.
          correlationId,
        });
        opening.markProcessed(undefined, at);
        await wagers.create(opening, wallet.balance);
        await ledger.create(openingEntry);
        await enqueueWagerEvents(session, opening, at, wallet.balance);
      }
      // UnitOfWork só entrega esta resposta após confirmar o commit de todos os registros.
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
