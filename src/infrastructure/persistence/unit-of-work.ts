import { Inject, Injectable } from '@nestjs/common';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import type {
  RepositorySession,
  UnitOfWork,
} from '../../application/ports/repositories.js';
import {
  PostgreSqlWalletRepository,
  PostgreSqlWagerRepository,
  PostgreSqlLedgerRepository,
} from './repositories.js';

@Injectable()
export class PostgreSqlUnitOfWork implements UnitOfWork {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async read<T>(
    operation: (session: RepositorySession) => Promise<T>,
  ): Promise<T> {
    return operation(this.session(this.orm.em.fork()));
  }
  async transaction<T>(
    operation: (session: RepositorySession) => Promise<T>,
  ): Promise<T> {
    // Cada execução isola o Identity Map. Todos os repositories compartilham a transação.
    // O retorno só é entregue depois de o commit e as constraints diferidas passarem.
    return this.orm.em
      .fork()
      .transactional((em) => operation(this.session(em)));
  }
  private session(em: EntityManager): RepositorySession {
    return {
      wallets: new PostgreSqlWalletRepository(em),
      wagers: new PostgreSqlWagerRepository(em),
      ledger: new PostgreSqlLedgerRepository(em),
    };
  }
}
