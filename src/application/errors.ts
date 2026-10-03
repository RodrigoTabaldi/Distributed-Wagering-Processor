// Erro de aplicação: a combinação jogador/moeda já pertence a outra wallet.
export class WalletAlreadyExistsError extends Error {
  constructor() {
    super('Wallet already exists for this player and currency');
    this.name = 'WalletAlreadyExistsError';
  }
}
