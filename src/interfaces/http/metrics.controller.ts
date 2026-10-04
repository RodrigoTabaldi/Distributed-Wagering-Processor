import { Controller, Get, Header, Inject } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { TELEMETRY } from '../../application/ports/telemetry.js';
import { Observability } from '../../infrastructure/observability/observability.js';
import { infrastructureHttpError } from './infrastructure-error.js';

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(TELEMETRY) private readonly telemetry: Observability,
  ) {}
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics() {
    try {
      // Inclui eventos em backoff: lag mede atraso real, além dos eventos devidos.
      const rows = await this.orm.em.fork().execute<{ lag: string }[]>(
        `SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(occurred_at)), 0)::text AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
      );
      return this.telemetry.metrics(Number(rows[0]?.lag ?? 0));
    } catch (error) {
      throw infrastructureHttpError(error, 'query metrics');
    }
  }
}
