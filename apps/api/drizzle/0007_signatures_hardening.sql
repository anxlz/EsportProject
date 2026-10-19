-- Hand-written follow-up to 0006 (Phase 4: electronic signatures).

-- 1. RLS on every table in the app schema (idempotent; re-run each phase so new tables are
--    covered). A test fails if any app table is left without RLS.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM %I', r);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- 2. Closed vocabularies (mirror packages/shared/src/contracts/catalog.ts).
ALTER TABLE app.signing_rounds ADD CONSTRAINT signing_rounds_status_check
  CHECK (status IN ('in_progress', 'completed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE app.contract_signers ADD CONSTRAINT contract_signers_role_check
  CHECK (role IN ('recipient', 'guardian'));
--> statement-breakpoint
ALTER TABLE app.contract_signers ADD CONSTRAINT contract_signers_status_check
  CHECK (status IN ('pending', 'signed'));
--> statement-breakpoint
ALTER TABLE app.contract_signers ADD CONSTRAINT contract_signers_signature_method_check
  CHECK (signature_method IS NULL OR signature_method IN ('typed', 'drawn'));
--> statement-breakpoint
ALTER TABLE app.contract_signers ADD CONSTRAINT contract_signers_verification_method_check
  CHECK (verification_method IS NULL OR verification_method IN ('email_code', 'access_code'));
--> statement-breakpoint
ALTER TABLE app.signing_links ADD CONSTRAINT signing_links_method_check
  CHECK (method IN ('email_code', 'access_code'));
--> statement-breakpoint
ALTER TABLE app.signing_links ADD CONSTRAINT signing_links_code_present
  CHECK ((method = 'access_code' AND access_code_hash IS NOT NULL)
      OR (method = 'email_code' AND destination IS NOT NULL));
--> statement-breakpoint
ALTER TABLE app.contract_signers ADD CONSTRAINT contract_signers_order_unique
  UNIQUE (round_id, sign_order);
--> statement-breakpoint
-- A contract is fully signed once: at most one completed round per contract.
CREATE UNIQUE INDEX signing_rounds_one_completed ON app.signing_rounds (contract_id)
  WHERE status = 'completed';
--> statement-breakpoint

-- 3. A signature, once given, is permanent: a signed signer row can't be changed or removed,
--    and no signer, round or link row is ever deleted (they are the signing record).
CREATE OR REPLACE FUNCTION app.contract_signers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contract_signers rows cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'a recorded signature cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Identity of the signer is fixed when the round starts.
  IF NEW.organization_id <> OLD.organization_id OR NEW.round_id <> OLD.round_id
     OR NEW.role <> OLD.role OR NEW.sign_order <> OLD.sign_order THEN
    RAISE EXCEPTION 'signer identity cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER contract_signers_guard
  BEFORE UPDATE OR DELETE ON app.contract_signers
  FOR EACH ROW EXECUTE FUNCTION app.contract_signers_guard();
--> statement-breakpoint

-- A completed or cancelled round is closed for good.
CREATE OR REPLACE FUNCTION app.signing_rounds_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signing_rounds rows cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'in_progress' THEN
    RAISE EXCEPTION 'a % signing round cannot be changed', OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.contract_id <> OLD.contract_id
     OR NEW.approval_request_id <> OLD.approval_request_id
     OR NEW.approved_document_sha256 <> OLD.approved_document_sha256
     OR NEW.minor <> OLD.minor THEN
    RAISE EXCEPTION 'signing round identity cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER signing_rounds_guard
  BEFORE UPDATE OR DELETE ON app.signing_rounds
  FOR EACH ROW EXECUTE FUNCTION app.signing_rounds_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.signing_links_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signing_links rows cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.token_hash <> OLD.token_hash OR NEW.signer_id <> OLD.signer_id
     OR NEW.organization_id <> OLD.organization_id OR NEW.method <> OLD.method THEN
    RAISE EXCEPTION 'signing link identity cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A revoked or used link stays that way.
  IF (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at) THEN
    RAISE EXCEPTION 'a revoked or used signing link cannot be reopened'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER signing_links_guard
  BEFORE UPDATE OR DELETE ON app.signing_links
  FOR EACH ROW EXECUTE FUNCTION app.signing_links_guard();
--> statement-breakpoint

-- 4. Existing organizations: give the roles seeded from the default templates the Phase 4
--    permission those templates now include. Only adds. Must mirror DEFAULT_ROLE_TEMPLATES in
--    packages/shared/src/permissions.ts together with 0005 (a test checks it).
INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['contracts.send_for_signature']) AS p(key)
WHERE r.template_key = 'head_of_esports'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['contracts.send_for_signature']) AS p(key)
WHERE r.template_key = 'esports_manager'
ON CONFLICT DO NOTHING;
