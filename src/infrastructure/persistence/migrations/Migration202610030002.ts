import { Migration } from '@mikro-orm/migrations';

// Agenda persistente: reiniciar a aplicação não apaga tentativas nem antecipa o backoff.
export class Migration202610030002 extends Migration {
  override up(): void {
    this.replaceGuard(true);
    this.addSql(`ALTER TABLE wager_transactions
      ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
      ADD COLUMN reference_next_attempt_at timestamptz;
      CREATE INDEX pending_reference_due ON wager_transactions (reference_next_attempt_at, id)
        WHERE status = 'PENDING_REFERENCE';
      UPDATE wager_transactions SET reference_next_attempt_at = CURRENT_TIMESTAMP
        WHERE status = 'PENDING_REFERENCE';`);
  }
  // Remove somente os metadados desta migration, preservando as operações financeiras.
  override down(): void {
    this.replaceGuard(false);
    this.addSql(`DROP INDEX pending_reference_due;
      ALTER TABLE wager_transactions DROP COLUMN reference_next_attempt_at, DROP COLUMN reference_attempts;`);
  }
  private replaceGuard(withSchedule: boolean): void {
    // Só metadados da agenda podem mudar; o payload e estados terminais continuam protegidos.
    const schedulingFields = withSchedule
      ? ", 'reference_attempts', 'reference_next_attempt_at'"
      : '';
    this
      .addSql(`CREATE OR REPLACE FUNCTION protect_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'Terminal transaction is immutable' USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - ARRAY['status','reference_transaction_id','failure_code','processed_at','observed_balance','updated_at'${schedulingFields}])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','reference_transaction_id','failure_code','processed_at','observed_balance','updated_at'${schedulingFields}]) THEN
          RAISE EXCEPTION 'Transaction business payload is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$;`);
  }
}
