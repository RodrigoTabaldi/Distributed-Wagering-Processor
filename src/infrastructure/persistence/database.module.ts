import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from './orm.config.js';

// Exporta uma conexão compartilhada; cada futuro caso de uso deverá usar em.fork().
@Module({
  providers: [
    { provide: MikroORM, useFactory: () => MikroORM.init(createOrmConfig()) },
  ],
  exports: [MikroORM],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  // Fecha o pool quando a aplicação terminar, evitando conexões abandonadas.
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
