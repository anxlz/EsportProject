-- Hand-written follow-up to 0008 (Phase 5: AI assistants).

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

-- 2. Closed vocabularies (mirror packages/shared/src/assistants/catalog.ts).
ALTER TABLE app.ai_conversations ADD CONSTRAINT ai_conversations_assistant_check
  CHECK (assistant IN ('general', 'formal_message', 'email', 'offer_optimizer', 'player_analyst'));
--> statement-breakpoint
ALTER TABLE app.ai_conversations ADD CONSTRAINT ai_conversations_reply_language_check
  CHECK (reply_language IN ('auto', 'ar', 'en'));
--> statement-breakpoint
ALTER TABLE app.ai_messages ADD CONSTRAINT ai_messages_role_check
  CHECK (role IN ('user', 'assistant'));
--> statement-breakpoint
ALTER TABLE app.ai_messages ADD CONSTRAINT ai_messages_status_check
  CHECK (status IN ('pending', 'complete', 'failed'));
--> statement-breakpoint
ALTER TABLE app.ai_messages ADD CONSTRAINT ai_messages_language_check
  CHECK (language IS NULL OR language IN ('ar', 'en'));
--> statement-breakpoint
ALTER TABLE app.ai_tool_calls ADD CONSTRAINT ai_tool_calls_kind_check
  CHECK (kind IN ('platform', 'web_search'));
--> statement-breakpoint
ALTER TABLE app.ai_tool_calls ADD CONSTRAINT ai_tool_calls_outcome_check
  CHECK (outcome IN ('ok', 'denied', 'not_found', 'error', 'unknown_tool'));
--> statement-breakpoint
ALTER TABLE app.ai_proposal_actions ADD CONSTRAINT ai_proposal_actions_action_check
  CHECK (action IN ('email_sent', 'offer_applied'));
--> statement-breakpoint

-- 3. The tool-call log and the record of human actions are append-only (spec §8.1 guardrail 4).
CREATE OR REPLACE FUNCTION app.ai_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (attempted %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER ai_tool_calls_append_only
  BEFORE UPDATE OR DELETE ON app.ai_tool_calls
  FOR EACH ROW EXECUTE FUNCTION app.ai_append_only();
--> statement-breakpoint
CREATE TRIGGER ai_proposal_actions_append_only
  BEFORE UPDATE OR DELETE ON app.ai_proposal_actions
  FOR EACH ROW EXECUTE FUNCTION app.ai_append_only();
--> statement-breakpoint

-- 4. Messages are never deleted. A user message never changes; an assistant reply only moves
--    from pending to complete or failed, once, and keeps its identity.
CREATE OR REPLACE FUNCTION app.ai_messages_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ai_messages rows cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a % message cannot be changed', OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.seq <> OLD.seq OR NEW.role <> OLD.role OR NEW.text IS DISTINCT FROM OLD.text THEN
    RAISE EXCEPTION 'message identity cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ai_messages_guard
  BEFORE UPDATE OR DELETE ON app.ai_messages
  FOR EACH ROW EXECUTE FUNCTION app.ai_messages_guard();
--> statement-breakpoint

-- 5. Existing organizations: give the roles seeded from the default templates the Phase 5
--    assistant permissions those templates now include. Only adds. Must mirror
--    DEFAULT_ROLE_TEMPLATES in packages/shared/src/permissions.ts (a test checks it).
INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['assistants.general', 'assistants.formal_message', 'assistants.email', 'assistants.offer_optimizer', 'assistants.player_analyst', 'assistants.send_email']) AS p(key)
WHERE r.template_key = 'head_of_esports'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['assistants.general', 'assistants.formal_message', 'assistants.email', 'assistants.offer_optimizer', 'assistants.player_analyst', 'assistants.send_email']) AS p(key)
WHERE r.template_key = 'esports_manager'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO app.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM app.roles r
CROSS JOIN unnest(ARRAY['assistants.general', 'assistants.formal_message', 'assistants.email']) AS p(key)
WHERE r.template_key = 'esports_operations'
ON CONFLICT DO NOTHING;
