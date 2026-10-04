import { Migration } from '@mikro-orm/migrations';

export class Migration202610030004 extends Migration {
  override up(): void {
    // Contexto fica no registro financeiro: retries preservam correlação e causa originais.
    // Drena triggers do backfill anterior antes de alterar a tabela no mesmo lote de migrations.
    this.addSql(`SET CONSTRAINTS ALL IMMEDIATE;
    ALTER TABLE wager_transactions ADD COLUMN correlation_id text, ADD COLUMN causation_id text;
    SET CONSTRAINTS ALL DEFERRED;
    CREATE TABLE outbox_messages (
      id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type text NOT NULL,
      payload jsonb NOT NULL, occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at timestamptz CHECK (isfinite(next_attempt_at)),
      published_at timestamptz CHECK (isfinite(published_at)),
      CHECK (jsonb_typeof(payload) = 'object'),
      CHECK (payload->>'eventId' = id::text AND payload->>'aggregateId' = aggregate_id::text AND payload->>'eventType' = event_type)
    );
    CREATE INDEX outbox_due ON outbox_messages (next_attempt_at, occurred_at, id) WHERE published_at IS NULL;
    CREATE FUNCTION protect_outbox_message() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.published_at IS NOT NULL OR
        (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
          IS DISTINCT FROM (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
        RAISE EXCEPTION 'Outbox envelope and published message are immutable' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER outbox_message_guard BEFORE UPDATE ON outbox_messages FOR EACH ROW EXECUTE FUNCTION protect_outbox_message();`);
  }
  override down(): void {
    this
      .addSql(`DROP TABLE outbox_messages; DROP FUNCTION protect_outbox_message();
      ALTER TABLE wager_transactions DROP COLUMN correlation_id, DROP COLUMN causation_id;`);
  }
}
