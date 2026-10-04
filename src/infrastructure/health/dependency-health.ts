import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../messaging/sqs.js';

@Injectable()
export class DependencyHealth implements OnApplicationShutdown {
  private readonly sqs = createSqsClient();
  private running?: Promise<{ postgres: boolean; sqs: boolean }>;
  private databaseProbe?: Promise<boolean>;
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}
  async ready() {
    // Compartilha sondagem em andamento: chamadas concorrentes não esgotam o pool.
    this.running ??= this.check().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async check() {
    const [postgres, sqs] = await Promise.all([this.postgres(), this.queues()]);
    return { postgres, sqs };
  }
  private async postgres(): Promise<boolean> {
    // Mantém no máximo uma aquisição de conexão pendente, inclusive quando o pool está esgotado.
    this.databaseProbe ??= this.probePostgres().finally(() => {
      this.databaseProbe = undefined;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.databaseProbe,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 2100);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async probePostgres(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      await this.orm.em.fork().transactional(
        async (em) => {
          // Limita no servidor e cancela a consulta em andamento no cliente.
          await em.execute("SET LOCAL statement_timeout = '2000ms'");
          await em.execute('SELECT 1');
        },
        {
          signal: controller.signal,
          inflightQueryAbortStrategy: 'cancel query',
        },
      );
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
  private async queues(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      // Verifica as três filas sem consumir mensagens ou exigir fila não vazia.
      await Promise.all(
        [
          'wager-transactions.fifo',
          'wager-transactions-dlq.fifo',
          'wager-events.fifo',
        ].map(async (QueueName) => {
          const { QueueUrl } = await this.sqs.send(
            new GetQueueUrlCommand({ QueueName }),
            { abortSignal: controller.signal },
          );
          if (!QueueUrl) throw new Error('Queue unavailable');
          await this.sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl,
              AttributeNames: ['QueueArn'],
            }),
            { abortSignal: controller.signal },
          );
        }),
      );
      return true;
    } catch {
      return false;
    } finally {
      // Se uma fila falhar antes das outras, cancela também as sondagens restantes.
      controller.abort();
      clearTimeout(timeout);
    }
  }
  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
