-- Hand-written follow-up to 0004 (Phase 3).

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

-- 2. Version history is append-only: a saved version can never be changed or removed.
CREATE OR REPLACE FUNCTION app.entity_versions_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'entity_versions is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER entity_versions_no_update_delete
  BEFORE UPDATE OR DELETE ON app.entity_versions
  FOR EACH ROW EXECUTE FUNCTION app.entity_versions_block_mutation();
--> statement-breakpoint

-- 3. Stored files are immutable once written (a new upload is a new row). Deleting is still
--    possible for cleanup of unreferenced uploads; foreign keys protect referenced files.
CREATE OR REPLACE FUNCTION app.stored_files_block_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stored_files rows are immutable'
    USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER stored_files_no_update
  BEFORE UPDATE ON app.stored_files
  FOR EACH ROW EXECUTE FUNCTION app.stored_files_block_update();
--> statement-breakpoint

-- 4. Existing organizations: give the roles seeded from the default templates the Phase 3
--    contract permissions those templates now include. Only adds. Must mirror
--    DEFAULT_ROLE_TEMPLATES in packages/shared/src/permissions.ts (a test checks it).
--    contracts.approve is deliberately NOT in any template: Owners delegate it explicitly.
INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['contracts.view', 'contracts.create', 'contracts.edit', 'contracts.export']) AS p(key)
WHERE r.template_key = 'head_of_esports'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['contracts.view', 'contracts.create', 'contracts.edit', 'contracts.export']) AS p(key)
WHERE r.template_key = 'esports_manager'
ON CONFLICT DO NOTHING;
