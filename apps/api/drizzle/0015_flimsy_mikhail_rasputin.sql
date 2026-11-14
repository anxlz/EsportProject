ALTER TABLE "app"."contract_termination_events" DROP CONSTRAINT "contract_termination_events_termination_fk";
--> statement-breakpoint
ALTER TABLE "app"."contract_terminations" DROP CONSTRAINT "contract_terminations_contract_fk";
--> statement-breakpoint
ALTER TABLE "app"."contract_terminations" ALTER COLUMN "status" SET DEFAULT 'requested';--> statement-breakpoint
ALTER TABLE "app"."contract_termination_events" ADD CONSTRAINT "contract_termination_events_termination_fk" FOREIGN KEY ("organization_id","termination_id") REFERENCES "app"."contract_terminations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contract_terminations" ADD CONSTRAINT "contract_terminations_contract_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "app"."contracts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contract_termination_events" ADD CONSTRAINT "contract_termination_events_action_check" CHECK ("app"."contract_termination_events"."action" in ('requested', 'accepted', 'rejected', 'withdrawn', 'executed', 'expired'));--> statement-breakpoint
ALTER TABLE "app"."contract_termination_events" ADD CONSTRAINT "contract_termination_events_to_status_check" CHECK ("app"."contract_termination_events"."to_status" in ('requested', 'pending_counterparty', 'accepted', 'rejected', 'withdrawn', 'executed', 'expired'));--> statement-breakpoint
ALTER TABLE "app"."contract_termination_events" ADD CONSTRAINT "contract_termination_events_from_status_check" CHECK ("app"."contract_termination_events"."from_status" is null or "app"."contract_termination_events"."from_status" in ('requested', 'pending_counterparty', 'accepted', 'rejected', 'withdrawn', 'executed', 'expired'));--> statement-breakpoint
ALTER TABLE "app"."contract_terminations" ADD CONSTRAINT "contract_terminations_status_check" CHECK ("app"."contract_terminations"."status" in ('requested', 'pending_counterparty', 'accepted', 'rejected', 'withdrawn', 'executed', 'expired'));--> statement-breakpoint
ALTER TABLE "app"."contract_terminations" ADD CONSTRAINT "contract_terminations_reason_code_check" CHECK ("app"."contract_terminations"."reason_code" in ('breach', 'mutual_agreement', 'non_performance', 'force_majeure', 'convenience', 'other'));--> statement-breakpoint
ALTER TABLE app.contract_terminations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_termination_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON app.contract_terminations, app.contract_termination_events FROM %I', r);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_termination_events_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'contract_termination_events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER contract_termination_events_no_update_delete
  BEFORE UPDATE OR DELETE ON app.contract_termination_events
  FOR EACH ROW EXECUTE FUNCTION app.contract_termination_events_block_mutation();