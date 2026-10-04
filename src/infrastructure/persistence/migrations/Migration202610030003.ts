import { Migration } from '@mikro-orm/migrations';

export class Migration202610030003 extends Migration {
  override up(): void {
    // A chave composta deduplica por consumidor, sem cache em memória nem ID artificial.
    this.addSql(`CREATE TABLE inbox_messages (
      consumer_name text NOT NULL CHECK (length(btrim(consumer_name)) > 0 AND consumer_name = btrim(consumer_name)),
      message_id text NOT NULL CHECK (length(btrim(message_id)) > 0 AND message_id = btrim(message_id)),
      payload_hash varchar(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      received_at timestamptz NOT NULL CHECK (isfinite(received_at)),
      processed_at timestamptz CHECK (isfinite(processed_at) AND processed_at >= received_at),
      CONSTRAINT inbox_message_identity PRIMARY KEY (consumer_name, message_id)
    );
    CREATE FUNCTION protect_inbox_message() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.processed_at IS NOT NULL OR
        (NEW.consumer_name, NEW.message_id, NEW.payload_hash, NEW.received_at)
          IS DISTINCT FROM (OLD.consumer_name, OLD.message_id, OLD.payload_hash, OLD.received_at) THEN
        RAISE EXCEPTION 'Inbox identity and completed message are immutable' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER inbox_message_guard BEFORE UPDATE ON inbox_messages
      FOR EACH ROW EXECUTE FUNCTION protect_inbox_message();`);
  }
  override down(): void {
    // Reverter apaga o histórico de deduplicação: somente em banco descartável ou rollback planejado.
    this.addSql(
      'DROP TABLE inbox_messages; DROP FUNCTION protect_inbox_message();',
    );
  }
}
