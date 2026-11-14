CREATE TABLE "app"."contract_termination_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"termination_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_termination_events_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."contract_terminations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"initiated_by_user_id" uuid NOT NULL,
	"initiator_role" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_details" text,
	"effective_date" text NOT NULL,
	"notice_period_days" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending_counterparty' NOT NULL,
	"counterparty_response_at" timestamp with time zone,
	"counterparty_note" text,
	"settlement_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_terminations_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "contract_terminations_notice_days" CHECK ("app"."contract_terminations"."notice_period_days" between 0 and 3650),
	CONSTRAINT "contract_terminations_reason_details" CHECK ("app"."contract_terminations"."reason_code" not in ('breach', 'non_performance') or length(trim(coalesce("app"."contract_terminations"."reason_details", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."contract_termination_events" ADD CONSTRAINT "contract_termination_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contract_termination_events" ADD CONSTRAINT "contract_termination_events_termination_fk" FOREIGN KEY ("organization_id","termination_id") REFERENCES "app"."contract_terminations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contract_terminations" ADD CONSTRAINT "contract_terminations_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contract_terminations" ADD CONSTRAINT "contract_terminations_contract_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "app"."contracts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_termination_events_history_idx" ON "app"."contract_termination_events" USING btree ("organization_id","termination_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_terminations_one_active" ON "app"."contract_terminations" USING btree ("organization_id","contract_id") WHERE "app"."contract_terminations"."status" in ('requested', 'pending_counterparty', 'accepted');--> statement-breakpoint
CREATE INDEX "contract_terminations_due_idx" ON "app"."contract_terminations" USING btree ("status","effective_date");