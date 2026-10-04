import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DependencyHealth } from '../../infrastructure/health/dependency-health.js';
import { Public } from './auth.module.js';

@Controller('health')
@Public()
export class HealthController {
  constructor(
    @Inject(DependencyHealth)
    private readonly dependencies: Pick<DependencyHealth, 'ready'>,
  ) {}
  @Get('live')
  live() {
    // Processo responde ao HTTP: nenhuma consulta a PostgreSQL ou SQS é necessária.
    return { status: 'up' };
  }
  @Get('ready')
  async ready() {
    const checks = await this.dependencies.ready();
    const body = {
      status: checks.postgres && checks.sqs ? 'up' : 'down',
      checks,
    };
    if (body.status === 'down')
      throw new ServiceUnavailableException({
        ...body,
        code: 'INFRASTRUCTURE_UNAVAILABLE',
      });
    return body;
  }
}
