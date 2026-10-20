-- Hand-written follow-up to 0010 (Phase 6: meetings and integrations).

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

-- 2. Closed vocabularies (mirror packages/shared/src/meetings/catalog.ts).
ALTER TABLE app.meetings ADD CONSTRAINT meetings_kind_check
  CHECK (kind IN ('standard', 'administrative'));
--> statement-breakpoint
ALTER TABLE app.meetings ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('scheduled', 'cancelled'));
--> statement-breakpoint
ALTER TABLE app.meetings ADD CONSTRAINT meetings_source_check
  CHECK (source IN ('platform', 'google_calendar', 'notion', 'obsidian', 'webhook'));
--> statement-breakpoint
ALTER TABLE app.meetings ADD CONSTRAINT meetings_start_local_format
  CHECK (start_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$');
--> statement-breakpoint
ALTER TABLE app.meetings ADD CONSTRAINT meetings_version_positive CHECK (version >= 1);
--> statement-breakpoint
ALTER TABLE app.meetings ADD CONSTRAINT meetings_reminders_check
  CHECK (cardinality(reminder_minutes) <= 3
         AND reminder_minutes <@ ARRAY[5, 15, 30, 60, 120, 1440, 2880]);
--> statement-breakpoint
ALTER TABLE app.meeting_participants ADD CONSTRAINT meeting_participants_response_check
  CHECK (response IN ('pending', 'accepted', 'declined'));
--> statement-breakpoint
ALTER TABLE app.meeting_participants ADD CONSTRAINT meeting_participants_responded_at
  CHECK ((response = 'pending') = (responded_at IS NULL));
--> statement-breakpoint
ALTER TABLE app.meeting_overrides ADD CONSTRAINT meeting_overrides_status_check
  CHECK (status IN ('cancelled', 'moved'));
--> statement-breakpoint
ALTER TABLE app.integration_connections ADD CONSTRAINT integration_connections_provider_check
  CHECK (provider IN ('google_calendar', 'notion', 'obsidian', 'webhook_outgoing', 'webhook_incoming'));
--> statement-breakpoint
ALTER TABLE app.integration_connections ADD CONSTRAINT integration_connections_status_check
  CHECK (status IN ('active', 'error', 'disconnected'));
--> statement-breakpoint
ALTER TABLE app.integration_connections ADD CONSTRAINT integration_connections_direction_check
  CHECK (
    (provider IN ('google_calendar', 'notion', 'obsidian') AND direction IN ('two_way', 'push_only'))
    OR (provider IN ('webhook_outgoing', 'webhook_incoming') AND direction IS NULL)
  );
--> statement-breakpoint
ALTER TABLE app.integration_connections ADD CONSTRAINT integration_connections_personal_check
  CHECK (personal = (provider IN ('google_calendar', 'obsidian')));
--> statement-breakpoint
ALTER TABLE app.integration_links ADD CONSTRAINT integration_links_state_check
  CHECK (state IN ('active', 'pending_create', 'unlinked'));
--> statement-breakpoint
ALTER TABLE app.integration_links ADD CONSTRAINT integration_links_active_remote
  CHECK (state <> 'active' OR remote_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE app.integration_jobs ADD CONSTRAINT integration_jobs_status_check
  CHECK (status IN ('pending', 'running', 'done', 'dead'));
--> statement-breakpoint
ALTER TABLE app.integration_jobs ADD CONSTRAINT integration_jobs_kind_check
  CHECK (kind IN ('push_meeting', 'pull', 'full_sync', 'deliver_webhook', 'renew_channel'));
--> statement-breakpoint
ALTER TABLE app.integration_events ADD CONSTRAINT integration_events_level_check
  CHECK (level IN ('info', 'warn', 'error'));
--> statement-breakpoint

-- 3. The integration log is append-only, like the audit log and the assistant lookup log.
CREATE OR REPLACE FUNCTION app.integration_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'integration_events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER integration_events_append_only
  BEFORE UPDATE OR DELETE ON app.integration_events
  FOR EACH ROW EXECUTE FUNCTION app.integration_events_append_only();
--> statement-breakpoint

-- 4. A meeting's version only moves forward (integrations rely on it to detect local changes).
CREATE OR REPLACE FUNCTION app.meetings_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'meeting version cannot go backwards'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'a meeting cannot move to another organization'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER meetings_version_guard
  BEFORE UPDATE ON app.meetings
  FOR EACH ROW EXECUTE FUNCTION app.meetings_version_guard();
--> statement-breakpoint

-- 5. Existing organizations: give the roles seeded from the default templates the Phase 6
--    meeting permissions those templates now include. Only adds. Must mirror
--    DEFAULT_ROLE_TEMPLATES in packages/shared/src/permissions.ts (a test checks it).
INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['meetings.view', 'meetings.create', 'meetings.manage']) AS p(key)
WHERE r.template_key = 'head_of_esports'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['meetings.view', 'meetings.create', 'meetings.manage']) AS p(key)
WHERE r.template_key = 'esports_manager'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['meetings.view']) AS p(key)
WHERE r.template_key = 'esports_operations'
ON CONFLICT DO NOTHING;
