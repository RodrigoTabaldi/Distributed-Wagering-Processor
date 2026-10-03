import { Migration } from '@mikro-orm/migrations';

// A migration é a fonte do schema: constraints, índices e triggers não dependem do ORM.
export class Migration202610030001 extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY, player_id uuid NOT NULL, currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) NOT NULL CHECK (balance >= 0 AND balance < 'Infinity'::numeric),
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        UNIQUE (player_id, currency), UNIQUE (id, player_id, currency)
      );
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY, provider_id text NOT NULL CHECK (length(btrim(provider_id)) > 0),
        external_transaction_id text NOT NULL CHECK (length(btrim(external_transaction_id)) > 0),
        idempotency_key text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) > 0),
        payload_hash varchar(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
        wallet_id uuid NOT NULL, player_id uuid NOT NULL, round_id text NOT NULL, game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) NOT NULL CHECK (amount >= 0 AND amount < 'Infinity'::numeric),
        currency varchar(3) NOT NULL,
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_external_transaction_id text, reference_transaction_id uuid,
        failure_code text, processed_at timestamptz,
        observed_balance numeric(20,2) CHECK (observed_balance >= 0 AND observed_balance < 'Infinity'::numeric),
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        UNIQUE (provider_id, external_transaction_id), UNIQUE (id, wallet_id, currency),
        FOREIGN KEY (wallet_id, player_id, currency) REFERENCES wallets (id, player_id, currency),
        FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id),
        CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CHECK (failure_code IS NULL OR length(btrim(failure_code)) > 0),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK (reference_external_transaction_id IS NULL OR (kind IN ('WIN','REFUND','ROLLBACK') AND length(btrim(reference_external_transaction_id)) > 0 AND reference_external_transaction_id <> external_transaction_id)),
        CHECK (status <> 'PENDING_REFERENCE' OR reference_external_transaction_id IS NOT NULL),
        CHECK (status <> 'PROCESSED' OR (reference_external_transaction_id IS NULL) = (reference_transaction_id IS NULL)),
        CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id)
      );
      CREATE UNIQUE INDEX processed_reversal_once ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE INDEX pending_reference_lookup ON wager_transactions (created_at, id) WHERE status = 'PENDING_REFERENCE';
      CREATE INDEX transactions_wallet_lookup ON wager_transactions (wallet_id, created_at, id);
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY, wallet_id uuid NOT NULL, transaction_id uuid NOT NULL,
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK (amount > 0 AND amount < 'Infinity'::numeric),
        currency varchar(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0 AND balance_before < 'Infinity'::numeric),
        balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0 AND balance_after < 'Infinity'::numeric),
        created_at timestamptz NOT NULL,
        UNIQUE (transaction_id, wallet_id),
        FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wager_transactions (id, wallet_id, currency),
        CHECK (balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE INDEX ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at, id);
    `);
    // UPDATE/DELETE/TRUNCATE do ledger são proibidos, mesmo por SQL direto.
    this.addSql(`
      CREATE FUNCTION reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Ledger is immutable' USING ERRCODE = '23514'; END; $$;
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_ledger_mutation();
      CREATE FUNCTION protect_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') AND NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'Terminal transaction is immutable' USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - ARRAY['status','reference_transaction_id','failure_code','processed_at','observed_balance','updated_at'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','reference_transaction_id','failure_code','processed_at','observed_balance','updated_at']) THEN
          RAISE EXCEPTION 'Transaction business payload is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER transaction_state_guard BEFORE UPDATE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION protect_transaction();
    `);
    // Executa no commit: permite inserir wallet/transação/ledger na mesma transação SQL.
    this.addSql(`
      CREATE FUNCTION check_wallet_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target uuid; stored numeric; reconstructed numeric;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN target := NEW.id; ELSE target := NEW.wallet_id; END IF;
        SELECT balance INTO stored FROM wallets WHERE id = target FOR UPDATE;
        SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)
          INTO reconstructed FROM wallet_ledger_entries WHERE wallet_id = target;
        IF stored IS DISTINCT FROM reconstructed THEN
          RAISE EXCEPTION 'Wallet balance must match ledger' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER wallet_balance_consistency AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_balance();
      CREATE CONSTRAINT TRIGGER ledger_balance_consistency AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger_balance();
      CREATE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE t wager_transactions; e wallet_ledger_entries; r wager_transactions; expected_direction text;
      BEGIN
        IF TG_TABLE_NAME = 'wager_transactions' THEN
          SELECT * INTO t FROM wager_transactions WHERE id = NEW.id;
        ELSE SELECT * INTO t FROM wager_transactions WHERE id = NEW.transaction_id; END IF;
        SELECT * INTO e FROM wallet_ledger_entries WHERE transaction_id = t.id AND wallet_id = t.wallet_id;
        IF t.status = 'PROCESSED' AND t.kind <> 'LOSS' AND t.amount > 0 THEN
          expected_direction := CASE WHEN t.kind = 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
          IF t.reference_transaction_id IS NOT NULL THEN
            SELECT * INTO r FROM wager_transactions WHERE id = t.reference_transaction_id;
            IF r.status <> 'PROCESSED' OR (r.provider_id,r.external_transaction_id,r.player_id,r.wallet_id,r.currency,r.round_id)
              IS DISTINCT FROM (t.provider_id,t.reference_external_transaction_id,t.player_id,t.wallet_id,t.currency,t.round_id)
              OR (t.kind IN ('REFUND','WIN') AND r.kind <> 'BET')
              OR (t.kind = 'ROLLBACK' AND r.kind NOT IN ('BET','WIN','REFUND'))
              OR (t.kind IN ('REFUND','ROLLBACK') AND t.amount <> r.amount) THEN
              RAISE EXCEPTION 'Invalid transaction reference' USING ERRCODE = '23514';
            END IF;
            IF t.kind = 'ROLLBACK' THEN expected_direction := CASE WHEN r.kind = 'BET' THEN 'CREDIT' ELSE 'DEBIT' END; END IF;
          END IF;
          IF e.id IS NULL OR e.amount <> t.amount OR e.direction <> expected_direction THEN
            RAISE EXCEPTION 'Processed financial transaction requires matching ledger' USING ERRCODE = '23514';
          END IF;
        ELSIF e.id IS NOT NULL THEN
          RAISE EXCEPTION 'Non-financial transaction cannot have ledger' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER transaction_ledger_consistency AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
      CREATE CONSTRAINT TRIGGER ledger_transaction_consistency AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
    `);
  }

  // Reverter esta migration remove o schema financeiro; executar apenas em banco descartável.
  override down(): void {
    this.addSql(`
      DROP TABLE wallet_ledger_entries;
      DROP TABLE wager_transactions;
      DROP TABLE wallets;
      DROP FUNCTION check_transaction_ledger();
      DROP FUNCTION check_wallet_ledger_balance();
      DROP FUNCTION protect_transaction();
      DROP FUNCTION reject_ledger_mutation();
    `);
  }
}
