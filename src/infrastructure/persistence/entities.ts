import { DecimalType, EntitySchema } from '@mikro-orm/core';

// Tipos de persistência separados do domínio. Dinheiro permanece string, nunca number.
export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  observedBalance?: string;
  referenceAttempts?: number;
  referenceNextAttemptAt?: Date;
  correlationId?: string;
  causationId?: string;
}
export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

// O modo string explícito impede que a hidratação do ORM perca centavos.
const monetaryColumn = () => ({
  type: new DecimalType('string'),
  precision: 20,
  scale: 2,
});
const timestampColumn = () => ({ type: Date, columnType: 'timestamptz' });

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}
export const InboxMessageEntity = new EntitySchema<InboxMessageRecord>({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', columnType: 'text', primary: true },
    messageId: { type: 'string', columnType: 'text', primary: true },
    payloadHash: { type: 'string', length: 64 },
    receivedAt: timestampColumn(),
    processedAt: { ...timestampColumn(), nullable: true },
  },
});

export const WalletEntity = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    balance: monetaryColumn(),
    version: { type: 'integer' },
    createdAt: timestampColumn(),
    updatedAt: timestampColumn(),
  },
});
export const WagerTransactionEntity = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', columnType: 'text' },
    externalTransactionId: { type: 'string', columnType: 'text' },
    idempotencyKey: { type: 'string', columnType: 'text' },
    payloadHash: { type: 'string', length: 64 },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string', columnType: 'text' },
    gameId: { type: 'string', columnType: 'text' },
    kind: { type: 'string', columnType: 'text' },
    amount: monetaryColumn(),
    currency: { type: 'string', length: 3 },
    status: { type: 'string', columnType: 'text' },
    referenceExternalTransactionId: {
      type: 'string',
      columnType: 'text',
      nullable: true,
    },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'string', columnType: 'text', nullable: true },
    processedAt: { ...timestampColumn(), nullable: true },
    createdAt: timestampColumn(),
    updatedAt: timestampColumn(),
    observedBalance: { ...monetaryColumn(), nullable: true },
    referenceAttempts: { type: 'integer', default: 0 },
    referenceNextAttemptAt: { ...timestampColumn(), nullable: true },
    correlationId: { type: 'string', columnType: 'text', nullable: true },
    causationId: { type: 'string', columnType: 'text', nullable: true },
  },
});

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}
export const OutboxMessageEntity = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string', columnType: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: timestampColumn(),
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { ...timestampColumn(), nullable: true },
    publishedAt: { ...timestampColumn(), nullable: true },
  },
});
export const LedgerEntryEntity = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string', columnType: 'text' },
    amount: monetaryColumn(),
    currency: { type: 'string', length: 3 },
    balanceBefore: monetaryColumn(),
    balanceAfter: monetaryColumn(),
    createdAt: timestampColumn(),
  },
});
