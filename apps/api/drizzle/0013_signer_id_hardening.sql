-- Hand-written follow-up to 0012 (ID-document patch to Phase 4 signing).

-- 1. RLS on every table in the app schema (idempotent; re-run so the new table is covered).
--    A test fails if any app table is left without RLS.
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

-- 2. Closed vocabularies and sane values (mirror packages/shared/src/contracts/catalog.ts).
ALTER TABLE app.signer_id_documents ADD CONSTRAINT signer_id_documents_type_check
  CHECK (document_type IN ('passport', 'national_id'));
--> statement-breakpoint
ALTER TABLE app.signer_id_documents ADD CONSTRAINT signer_id_documents_content_type_check
  CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'));
--> statement-breakpoint
ALTER TABLE app.signer_id_documents ADD CONSTRAINT signer_id_documents_size_check
  CHECK (size_bytes BETWEEN 1 AND 8388608);
--> statement-breakpoint
ALTER TABLE app.signer_id_documents ADD CONSTRAINT signer_id_documents_sha256_check
  CHECK (sha256 ~ '^[0-9a-f]{64}$');
--> statement-breakpoint

-- 3. The signature points at the document it was given with.
ALTER TABLE app.contract_signers ADD CONSTRAINT contract_signers_id_document_fk
  FOREIGN KEY (organization_id, id_document_id)
  REFERENCES app.signer_id_documents (organization_id, id) ON DELETE RESTRICT;
--> statement-breakpoint

-- 4. A recipient's signature needs an identity document from now on. NOT VALID: signatures
--    recorded before this patch are left as they were (and can't change anyway); every new or
--    updated row is checked. Guardians are not asked for one.
ALTER TABLE app.contract_signers ADD CONSTRAINT contract_signers_recipient_id_document
  CHECK (role <> 'recipient' OR status <> 'signed' OR id_document_id IS NOT NULL) NOT VALID;
--> statement-breakpoint

-- 5. …and it must be this signer's own, current upload.
CREATE OR REPLACE FUNCTION app.contract_signers_id_document_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.signer_id_documents d
    WHERE d.id = NEW.id_document_id AND d.signer_id = NEW.id
      AND d.organization_id = NEW.organization_id AND d.superseded_at IS NULL
  ) THEN
    RAISE EXCEPTION 'the identity document must be this signer''s current upload'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER contract_signers_id_document_check
  BEFORE INSERT OR UPDATE OF id_document_id ON app.contract_signers
  FOR EACH ROW EXECUTE FUNCTION app.contract_signers_id_document_check();
--> statement-breakpoint

-- 6. Uploads are kept as given: never deleted, never edited. A new upload before signing marks
--    the previous one superseded (once). Nothing can be added after the signer has signed or
--    once the round is closed. Retention and deletion are an open product decision; when it is
--    made, a migration changes this rule deliberately.
CREATE OR REPLACE FUNCTION app.signer_id_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signer_id_documents rows cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.contract_signers s
      JOIN app.signing_rounds r ON r.id = s.round_id
      WHERE s.id = NEW.signer_id AND s.round_id = NEW.round_id
        AND s.organization_id = NEW.organization_id
        AND s.status = 'pending' AND r.status = 'in_progress'
    ) THEN
      RAISE EXCEPTION 'an identity document can only be added by a pending signer of an open round'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
     OR (to_jsonb(NEW) - 'superseded_at') <> (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'an identity document record cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only replacing an upload while the signer is still pending in an open round.
  IF NOT EXISTS (
    SELECT 1 FROM app.contract_signers s
    JOIN app.signing_rounds r ON r.id = s.round_id
    WHERE s.id = OLD.signer_id AND s.status = 'pending' AND r.status = 'in_progress'
  ) THEN
    RAISE EXCEPTION 'an identity document can only be replaced before signing'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER signer_id_documents_guard
  BEFORE INSERT OR UPDATE OR DELETE ON app.signer_id_documents
  FOR EACH ROW EXECUTE FUNCTION app.signer_id_documents_guard();
--> statement-breakpoint

-- 7. The stored bytes of an identity document are kept too (stored_files already refuses
--    updates since 0005).
CREATE OR REPLACE FUNCTION app.stored_files_keep_id_documents() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'signer_id_document' THEN
    RAISE EXCEPTION 'identity document files cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER stored_files_keep_id_documents
  BEFORE DELETE ON app.stored_files
  FOR EACH ROW EXECUTE FUNCTION app.stored_files_keep_id_documents();
