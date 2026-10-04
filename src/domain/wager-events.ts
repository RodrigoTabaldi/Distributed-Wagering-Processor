import {
  IntegrationEvent,
  type IntegrationEventProps,
} from './integration-event.js';
import type { MoneyProps } from './money.js';
import type { LedgerDirection } from './wallet-ledger-entry.js';
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

export interface WagerEventData {
  transactionId: string;
  externalTransactionId: string;
  providerId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  balance: MoneyProps;
  failureCode?: FailureCode;
}
export interface WalletBalanceEventData {
  transactionId: string;
  walletId: string;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  direction: LedgerDirection;
  money: MoneyProps;
  walletVersion: number;
}
// Cada tipo concreto tem nome e versão estáveis; nenhuma classe carrega instâncias Money no JSON.
export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
    Object.freeze(this);
  }
}
export class WagerTransactionRejected extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
    Object.freeze(this);
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
    Object.freeze(this);
  }
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceEventData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  constructor(props: IntegrationEventProps<WalletBalanceEventData>) {
    super(props);
    Object.freeze(this);
  }
}

// Falha técnica terminal é um resultado auditável, separado de rejeição de negócio.
export class WagerTransactionFailed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;
  constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
    Object.freeze(this);
  }
}
