// Erro de aplicação: a combinação jogador/moeda já pertence a outra wallet.
export class WalletAlreadyExistsError extends Error {
  constructor() {
    super('Wallet already exists for this player and currency');
    this.name = 'WalletAlreadyExistsError';
  }
}

// O adapter só usa este erro quando repetir a operação sem corrigir a infraestrutura não resolve.
// Timeout, conexão perdida e deadlock continuam sendo transitórios.
export class PermanentInfrastructureError extends Error {
  constructor() {
    super('Permanent infrastructure failure');
    this.name = 'PermanentInfrastructureError';
  }
}

export function isPermanentInfrastructureFailure(error: unknown): boolean {
  if (error instanceof PermanentInfrastructureError) return true;
  // Tabela, coluna ou função ausente exige corrigir o deploy; esperar não corrige o schema.
  // Classificação explícita evita tratar todo erro desconhecido como definitivo.
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    ['42P01', '42703', '42883'].includes(String(error.code))
  );
}
