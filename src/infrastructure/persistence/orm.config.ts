import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import {
  LedgerEntryEntity,
  WagerTransactionEntity,
  WalletEntity,
} from './entities.js';
import { Migration202610030001 } from './migrations/Migration202610030001.js';

// Credenciais vêm do ambiente; nunca são registradas em logs ou versionadas.
export function createOrmConfig(dbName = process.env.DB_NAME ?? 'dwp') {
  const password = process.env.DB_PASSWORD;
  if (!password) throw new Error('Configure DB_PASSWORD in .env');
  const port = Number(process.env.DB_PORT ?? '55432');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid DB_PORT');
  return defineConfig({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port,
    user: process.env.DB_USER ?? 'dwp',
    password,
    dbName,
    entities: [WalletEntity, WagerTransactionEntity, LedgerEntryEntity],
    extensions: [Migrator],
    migrations: {
      migrationsList: [Migration202610030001],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    debug: false,
  });
}
