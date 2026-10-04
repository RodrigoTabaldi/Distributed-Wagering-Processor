import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { ReprocessPendingReferences } from '../../application/reprocess-pending-references.js';
import { REFERENCE_RETRY_POLICY } from '../../application/reference-retry-policy.js';

@Injectable()
export class PendingReferenceWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private readonly controller = new AbortController();

  constructor(
    @Inject(ReprocessPendingReferences)
    private readonly reprocess: ReprocessPendingReferences,
  ) {}

  onApplicationBootstrap(): void {
    // PostgreSQL guarda a agenda; este timer apenas consulta o trabalho vencido.
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, REFERENCE_RETRY_POLICY.pollIntervalMs);
    this.timer.unref();
  }

  tick(): Promise<void> {
    // Uma instância não sobrepõe seus lotes. Entre instâncias, o lock no banco protege o saldo.
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.poll().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async poll(): Promise<void> {
    try {
      const results = await this.reprocess.runDue(
        new Date(),
        this.controller.signal,
      );
      for (const result of results) {
        // Registra a falha sem expor SQL, credenciais ou payload. A tentativa será retomada.
        if (result.outcome === 'failed')
          this.logger.error(
            'Pending reference attempt rolled back; retry remains scheduled',
          );
      }
    } catch {
      this.logger.error(
        'Pending reference polling failed; next poll will retry',
      );
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    // Para novas consultas e aguarda o commit/rollback atual antes de fechar o pool do banco.
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const deadline = setTimeout(() => this.controller.abort(), 10000);
    try {
      await this.active;
    } finally {
      clearTimeout(deadline);
    }
  }
}
