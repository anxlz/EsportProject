-- Hand-written follow-up to 0002 (Phase 2).

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

-- 2. Existing organizations: give the roles that were seeded from the default templates the
--    Phase 2 permissions those templates now include (new organizations get them at signup).
--    Only adds; never removes anything an Owner configured. Must mirror DEFAULT_ROLE_TEMPLATES
--    in packages/shared/src/permissions.ts.
INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY[
  'rosters.view', 'rosters.create', 'rosters.edit', 'rosters.delete', 'rosters.export',
  'tournaments.view', 'tournaments.create', 'tournaments.edit', 'tournaments.delete',
  'finance.view', 'finance.create', 'finance.edit', 'finance.delete', 'finance.export',
  'budgets.manage'
]) AS p(key)
WHERE r.template_key = 'head_of_esports'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY[
  'rosters.view', 'rosters.create', 'rosters.edit', 'rosters.export',
  'tournaments.view', 'finance.view', 'finance.create', 'finance.export'
]) AS p(key)
WHERE r.template_key = 'esports_manager'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['rosters.view', 'tournaments.view']) AS p(key)
WHERE r.template_key = 'esports_operations'
ON CONFLICT DO NOTHING;
