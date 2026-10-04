import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  TELEMETRY,
  NOOP_TELEMETRY,
  type Telemetry,
  type TelemetryEvent,
} from '../../application/ports/telemetry.js';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import type {
  RepositorySession,
  UnitOfWork,
} from '../../application/ports/repositories.js';
import {
  PostgreSqlWalletRepository,
  PostgreSqlWagerRepository,
  PostgreSqlLedgerRepository,
  PostgreSqlPendingReferenceRepository,
  PostgreSqlInboxRepository,
  PostgreSqlOutboxRepository,
} from './repositories.js';

@Injectable()
export class PostgreSqlUnitOfWork implements UnitOfWork {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Optional()
    @Inject(TELEMETRY)
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {}

  async read<T>(
    operation: (session: RepositorySession) => Promise<T>,
  ): Promise<T> {
    return operation(this.session(this.orm.em.fork()));
  }
  async transaction<T>(
    operation: (session: RepositorySession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    // Cada execução isola o Identity Map. Todos os repositories compartilham a transação.
    // O retorno só é entregue depois de o commit e as constraints diferidas passarem.
    const observations: TelemetryEvent[] = [];
    const started = performance.now();
    try {
      const result = await this.orm.em.fork().transactional(
        (em) =>
          operation({
            ...this.session(em),
            recordAfterCommit: (event) => observations.push(event),
          }),
        {
          signal,
          // SIGTERM pode cancelar uma consulta em andamento; o ORM conclui o rollback antes do retorno.
          inflightQueryAbortStrategy: 'cancel query',
        },
      );
      for (const event of observations) this.observe(event);
      return result;
    } catch (error) {
      // Timeout de lock, deadlock, serialização e conflito de versão são observáveis.
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (
        ['55P03', '40P01', '40001'].includes(String(code)) ||
        (error instanceof Error && error.name === 'PersistenceConflictError')
      )
        this.observe({ type: 'lock_conflict' });
      throw error;
    } finally {
      // Telemetria é auxiliar: sua falha nunca substitui o resultado financeiro ou o erro original.
      try {
        this.telemetry.duration('sql', (performance.now() - started) / 1000);
      } catch {
        /* Sem alterar o resultado. */
      }
    }
  }
  private observe(event: TelemetryEvent): void {
    try {
      this.telemetry.record(event);
    } catch {
      /* O commit já terminou; não provocamos replay por falha de log. */
    }
  }
  private session(em: EntityManager): RepositorySession {
    return {
      wallets: new PostgreSqlWalletRepository(em),
      wagers: new PostgreSqlWagerRepository(em),
      ledger: new PostgreSqlLedgerRepository(em),
      pendingReferences: new PostgreSqlPendingReferenceRepository(em),
      inbox: new PostgreSqlInboxRepository(em),
      outbox: new PostgreSqlOutboxRepository(em),
    };
  }
}
