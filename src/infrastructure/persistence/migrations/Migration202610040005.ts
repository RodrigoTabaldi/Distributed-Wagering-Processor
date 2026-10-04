import { Migration } from '@mikro-orm/migrations';

// Adiciona apenas metadados de entrega; o envelope e a auditoria financeira permanecem imutáveis.
export class Migration202610040005 extends Migration {
  override up(): void {
    this.addSql(`ALTER TABLE outbox_messages
      ADD COLUMN claim_token uuid,
      ADD COLUMN lease_expires_at timestamptz,
      ADD CONSTRAINT outbox_lease_pair CHECK ((claim_token IS NULL) = (lease_expires_at IS NULL)),
      ADD CONSTRAINT outbox_lease_finite CHECK (lease_expires_at IS NULL OR isfinite(lease_expires_at)),
      ADD CONSTRAINT outbox_published_without_lease CHECK (published_at IS NULL OR claim_token IS NULL);
      CREATE INDEX outbox_lease_recovery ON outbox_messages (lease_expires_at) WHERE published_at IS NULL;`);
  }
  override down(): void {
    // Rollback exige parar publishers com leases; não remove eventos nem histórico financeiro.
    this.addSql(`DROP INDEX outbox_lease_recovery;
      ALTER TABLE outbox_messages DROP CONSTRAINT outbox_published_without_lease,
        DROP CONSTRAINT outbox_lease_finite, DROP CONSTRAINT outbox_lease_pair,
        DROP COLUMN lease_expires_at, DROP COLUMN claim_token;`);
  }
}
