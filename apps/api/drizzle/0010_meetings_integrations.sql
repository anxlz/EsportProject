CREATE TABLE "app"."integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"personal" boolean NOT NULL,
	"direction" text,
	"status" text DEFAULT 'active' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"team_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"token_hash" text,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel" jsonb,
	"last_sync_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"last_error_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failure_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "integration_connections_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."integration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"level" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"meeting_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."integration_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"meeting_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."integration_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"remote_id" text,
	"remote_version" text,
	"remote_url" text,
	"synced_snapshot" jsonb,
	"local_version" integer,
	"state" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_links_connection_meeting_unique" UNIQUE("connection_id","meeting_id")
);
--> statement-breakpoint
CREATE TABLE "app"."meeting_overrides" (
	"organization_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"original_start" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_overrides_pk" PRIMARY KEY("meeting_id","original_start"),
	CONSTRAINT "meeting_overrides_moved_times" CHECK ("app"."meeting_overrides"."status" <> 'moved' or ("app"."meeting_overrides"."start_at" is not null and "app"."meeting_overrides"."end_at" > "app"."meeting_overrides"."start_at"))
);
--> statement-breakpoint
CREATE TABLE "app"."meeting_participants" (
	"organization_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"response" text DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_participants_pk" PRIMARY KEY("meeting_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."meeting_reminder_deliveries" (
	"organization_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"occurrence_start" timestamp with time zone NOT NULL,
	"offset_minutes" integer NOT NULL,
	"recipients" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_reminder_deliveries_pk" PRIMARY KEY("meeting_id","occurrence_start","offset_minutes")
);
--> statement-breakpoint
CREATE TABLE "app"."meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text DEFAULT 'standard' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"notes" text,
	"team_id" uuid,
	"department_id" uuid,
	"time_zone" text NOT NULL,
	"start_local" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"recurrence" jsonb,
	"starts_at" timestamp with time zone NOT NULL,
	"series_ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"cancel_reason" text,
	"cancelled_at" timestamp with time zone,
	"organizer_user_id" uuid,
	"reminder_minutes" integer[] DEFAULT '{15}'::integer[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'platform' NOT NULL,
	"source_connection_id" uuid,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "meetings_duration_range" CHECK ("app"."meetings"."duration_minutes" between 5 and 1440),
	CONSTRAINT "meetings_team_or_department" CHECK ("app"."meetings"."team_id" is null or "app"."meetings"."department_id" is null),
	CONSTRAINT "meetings_administrative_org_wide" CHECK ("app"."meetings"."kind" <> 'administrative' or ("app"."meetings"."team_id" is null and "app"."meetings"."department_id" is null)),
	CONSTRAINT "meetings_series_order" CHECK ("app"."meetings"."series_ends_at" > "app"."meetings"."starts_at"),
	CONSTRAINT "meetings_cancelled_at" CHECK (("app"."meetings"."status" = 'cancelled') = ("app"."meetings"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."webhook_receipts" (
	"connection_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_receipts_pk" PRIMARY KEY("connection_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD CONSTRAINT "integration_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD CONSTRAINT "integration_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_connections" ADD CONSTRAINT "integration_connections_team_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "app"."teams"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_events" ADD CONSTRAINT "integration_events_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "app"."integration_connections"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_jobs" ADD CONSTRAINT "integration_jobs_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "app"."integration_connections"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_links" ADD CONSTRAINT "integration_links_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "app"."integration_connections"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."integration_links" ADD CONSTRAINT "integration_links_meeting_fk" FOREIGN KEY ("organization_id","meeting_id") REFERENCES "app"."meetings"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meeting_overrides" ADD CONSTRAINT "meeting_overrides_meeting_fk" FOREIGN KEY ("organization_id","meeting_id") REFERENCES "app"."meetings"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_fk" FOREIGN KEY ("organization_id","meeting_id") REFERENCES "app"."meetings"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meeting_participants" ADD CONSTRAINT "meeting_participants_member_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "app"."organization_members"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meeting_reminder_deliveries" ADD CONSTRAINT "meeting_reminder_deliveries_meeting_fk" FOREIGN KEY ("organization_id","meeting_id") REFERENCES "app"."meetings"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD CONSTRAINT "meetings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD CONSTRAINT "meetings_organizer_user_id_users_id_fk" FOREIGN KEY ("organizer_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD CONSTRAINT "meetings_team_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "app"."teams"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."meetings" ADD CONSTRAINT "meetings_department_fk" FOREIGN KEY ("organization_id","department_id") REFERENCES "app"."departments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."webhook_receipts" ADD CONSTRAINT "webhook_receipts_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "app"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_token_hash_unique" ON "app"."integration_connections" USING btree ("token_hash") WHERE "app"."integration_connections"."token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_one_personal" ON "app"."integration_connections" USING btree ("organization_id","owner_user_id","provider") WHERE "app"."integration_connections"."personal" and "app"."integration_connections"."status" <> 'disconnected';--> statement-breakpoint
CREATE INDEX "integration_connections_org_idx" ON "app"."integration_connections" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE INDEX "integration_events_connection_idx" ON "app"."integration_events" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_jobs_due_idx" ON "app"."integration_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "integration_jobs_connection_idx" ON "app"."integration_jobs" USING btree ("connection_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_jobs_pending_dedupe" ON "app"."integration_jobs" USING btree ("connection_id","dedupe_key") WHERE "app"."integration_jobs"."status" = 'pending' and "app"."integration_jobs"."dedupe_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_links_connection_remote_unique" ON "app"."integration_links" USING btree ("connection_id","remote_id") WHERE "app"."integration_links"."remote_id" is not null;--> statement-breakpoint
CREATE INDEX "integration_links_meeting_idx" ON "app"."integration_links" USING btree ("organization_id","meeting_id");--> statement-breakpoint
CREATE INDEX "meeting_participants_user_idx" ON "app"."meeting_participants" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "meetings_org_window_idx" ON "app"."meetings" USING btree ("organization_id","series_ends_at","starts_at");--> statement-breakpoint
CREATE INDEX "meetings_team_idx" ON "app"."meetings" USING btree ("organization_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_external_id_unique" ON "app"."meetings" USING btree ("source_connection_id","external_id") WHERE "app"."meetings"."external_id" is not null;