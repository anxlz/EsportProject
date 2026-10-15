-- Hand-written migration: protections drizzle-kit cannot express from the TypeScript schema.

-- 1. Audit log is append-only. UPDATE and DELETE raise an error for every role, including the
--    API's own connection. (TRUNCATE is deliberately not blocked so test suites can reset state;
--    the API never issues TRUNCATE.)
CREATE OR REPLACE FUNCTION app.audit_logs_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON app.audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.audit_logs_block_mutation();
--> statement-breakpoint

-- 2. Row Level Security ON for every table in the app schema, with no policies. Roles other
--    than the table owner (e.g. Supabase's anon / authenticated roles used by its public REST
--    API) are therefore denied all rows. The API connects as the owner, which bypasses RLS,
--    and enforces tenancy in application code.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint

-- 3. On Supabase, make sure the API-facing roles cannot even see the schema. These roles do
--    not exist on a plain local Postgres, so the block is conditional.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM %I', r);
    END IF;
  END LOOP;
END $$;
