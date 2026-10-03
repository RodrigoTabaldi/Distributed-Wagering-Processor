import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from './orm.config.js';
import { UNIT_OF_WORK } from '../../application/ports/repositories.js';
import { PostgreSqlUnitOfWork } from './unit-of-work.js';

// Exporta uma conexão compartilhada; cada futuro caso de uso deverá usar em.fork().
@Module({
  providers: [
    { provide: MikroORM, useFactory: () => MikroORM.init(createOrmConfig()) },
    { provide: UNIT_OF_WORK, useClass: PostgreSqlUnitOfWork },
  ],
  exports: [MikroORM, UNIT_OF_WORK],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  // Fecha o pool quando a aplicação terminar, evitando conexões abandonadas.
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
