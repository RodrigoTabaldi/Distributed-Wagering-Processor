import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createServer } from 'node:net';
import { createOrmConfig } from '../../src/infrastructure/persistence/orm.config.js';
import { DependencyHealth } from '../../src/infrastructure/health/dependency-health.js';
import { HealthController } from '../../src/interfaces/http/health.controller.js';
import {
  createSqsClient,
  provisionQueues,
} from '../../src/infrastructure/messaging/sqs.js';

const container = `dwp-health-test-${crypto.randomUUID().replaceAll('-', '')}`;
let created = false;
let orm: MikroORM;
let app: INestApplication;
async function docker(...args: string[]) {
  // Argumentos separados evitam shell/interpolação; nunca usa o container ou volume do usuário.
  const child = Bun.spawn(['docker', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Docker health fixture failed: ${stderr}`);
  return stdout.trim();
}
describe('Health com queda real de PostgreSQL em container descartável', () => {
  beforeAll(async () => {
    // Reserva um número de porta e fixa o mapeamento: Docker pode trocar portas aleatórias no restart.
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await docker(
      'run',
      '--detach',
      '--name',
      container,
      '--publish',
      `127.0.0.1:${port}:5432`,
      '--env',
      'POSTGRES_USER=dwp',
      '--env',
      'POSTGRES_DB=dwp_test',
      '--env',
      'POSTGRES_PASSWORD=health-test-only',
      'postgres:17.6-alpine',
    );
    created = true;
    const deadline = Date.now() + 20000;
    while (true) {
      try {
        await docker(
          'exec',
          container,
          'pg_isready',
          // O servidor Unix temporário do entrypoint ainda não está pronto para a aplicação.
          '-h',
          '127.0.0.1',
          '-U',
          'dwp',
          '-d',
          'dwp_test',
        );
        break;
      } catch {
        if (Date.now() >= deadline)
          throw new Error('Health fixture PostgreSQL did not start');
        await Bun.sleep(100);
      }
    }
    orm = await MikroORM.init({
      ...createOrmConfig('dwp_test'),
      contextName: container,
      host: '127.0.0.1',
      port,
      user: 'dwp',
      password: 'health-test-only',
      pool: { min: 1, max: 1 },
    });
    const client = createSqsClient();
    try {
      await provisionQueues(client);
    } finally {
      client.destroy();
    }
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DependencyHealth, useValue: new DependencyHealth(orm) },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  }, 30000);
  afterAll(async () => {
    if (!/^dwp-health-test-[a-f0-9]{32}$/.test(container))
      throw new Error('Unsafe container target');
    try {
      if (app) await app.close();
      if (orm) await orm.close(true);
    } finally {
      if (created) {
        // Sem volume montado: remove exclusivamente a fixture criada por esta suíte.
        await docker('rm', '--force', container);
      }
    }
  });
  it('PostgreSQL parado retorna ready 503, mantém live 200 e recupera após reinício', async () => {
    const up = await request(app.getHttpServer()).get('/health/ready');
    expect(up.body).toEqual({
      status: 'up',
      checks: { postgres: true, sqs: true },
    });
    expect(up.status).toBe(200);
    await docker('stop', '--time', '1', container);
    const down = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(down.body.checks).toEqual({ postgres: false, sqs: true });
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'up' });
    await docker('start', container);
    const deadline = Date.now() + 10000;
    while (true) {
      const ready = await request(app.getHttpServer()).get('/health/ready');
      if (ready.status === 200) break;
      if (Date.now() >= deadline) throw new Error('Readiness did not recover');
      await Bun.sleep(100);
    }
    await request(app.getHttpServer()).get('/health/live').expect(200);
  }, 30000);
});
