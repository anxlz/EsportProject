CREATE TABLE "app"."approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"requested_by_user_id" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	"self_approved" boolean DEFAULT false NOT NULL,
	"document_file_id" uuid,
	"document_sha256" text,
	CONSTRAINT "approval_requests_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "approval_requests_reject_reason" CHECK ("app"."approval_requests"."status" <> 'rejected' or ("app"."approval_requests"."comment" is not null and length(trim("app"."approval_requests"."comment")) > 0)),
	CONSTRAINT "approval_requests_approved_document" CHECK ("app"."approval_requests"."status" <> 'approved' or "app"."approval_requests"."document_file_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."clause_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"feedback" text,
	"revision_of" uuid,
	"status" text DEFAULT 'proposed' NOT NULL,
	"output" jsonb NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "clause_proposals_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."contract_counters" (
	"organization_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last" integer NOT NULL,
	CONSTRAINT "contract_counters_pk" PRIMARY KEY("organization_id","year")
);
--> statement-breakpoint
CREATE TABLE "app"."contract_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"description_en" text,
	"description_ar" text,
	"archived_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_types_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"contract_type_id" uuid NOT NULL,
	"team_id" uuid,
	"roster_member_id" uuid,
	"game_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"recipient_name" text,
	"current_version" integer DEFAULT 0 NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approved_request_id" uuid,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "contracts_org_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "contracts_roster_needs_team" CHECK ("app"."contracts"."roster_member_id" is null or "app"."contracts"."team_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."document_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"legal_name_en" text,
	"legal_name_ar" text,
	"commercial_registration" text,
	"tax_number" text,
	"address_en" text,
	"address_ar" text,
	"email" text,
	"phone" text,
	"website" text,
	"header_text_en" text,
	"header_text_ar" text,
	"footer_text_en" text,
	"footer_text_ar" text,
	"logo_file_id" uuid,
	"logo_position" text DEFAULT 'start' NOT NULL,
	"background_kind" text DEFAULT 'none' NOT NULL,
	"background_file_id" uuid,
	"margin_top_mm" integer DEFAULT 20 NOT NULL,
	"margin_bottom_mm" integer DEFAULT 20 NOT NULL,
	"margin_start_mm" integer DEFAULT 18 NOT NULL,
	"margin_end_mm" integer DEFAULT 18 NOT NULL,
	"page_border" boolean DEFAULT false NOT NULL,
	"font_size_pt" real DEFAULT 10.5 NOT NULL,
	"line_height" real DEFAULT 1.55 NOT NULL,
	"default_language" text DEFAULT 'bilingual' NOT NULL,
	"stamp_file_id" uuid,
	"stamp_position" text DEFAULT 'end' NOT NULL,
	"stamp_width_mm" integer DEFAULT 35 NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."entity_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_versions_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "entity_versions_entity_version_unique" UNIQUE("entity_type","entity_id","version")
);
--> statement-breakpoint
CREATE TABLE "app"."stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_files_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."template_clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_type_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"required" boolean NOT NULL,
	"title_en" text NOT NULL,
	"title_ar" text NOT NULL,
	"body_en" text NOT NULL,
	"body_ar" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."organizations" ALTER COLUMN "base_currency" SET DEFAULT 'SAR';--> statement-breakpoint
ALTER TABLE "app"."organizations" ALTER COLUMN "enabled_currencies" SET DEFAULT '{SAR,USD}'::text[];--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_contract_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "app"."contracts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_version_fk" FOREIGN KEY ("organization_id","version_id") REFERENCES "app"."entity_versions"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."approval_requests" ADD CONSTRAINT "approval_requests_document_fk" FOREIGN KEY ("organization_id","document_file_id") REFERENCES "app"."stored_files"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."clause_proposals" ADD CONSTRAINT "clause_proposals_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."clause_proposals" ADD CONSTRAINT "clause_proposals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."clause_proposals" ADD CONSTRAINT "clause_proposals_contract_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "app"."contracts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contract_counters" ADD CONSTRAINT "contract_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contract_types" ADD CONSTRAINT "contract_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contract_types" ADD CONSTRAINT "contract_types_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contracts" ADD CONSTRAINT "contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contracts" ADD CONSTRAINT "contracts_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contracts" ADD CONSTRAINT "contracts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contracts" ADD CONSTRAINT "contracts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contracts" ADD CONSTRAINT "contracts_type_fk" FOREIGN KEY ("organization_id","contract_type_id") REFERENCES "app"."contract_types"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contracts" ADD CONSTRAINT "contracts_team_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "app"."teams"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contracts" ADD CONSTRAINT "contracts_roster_member_fk" FOREIGN KEY ("organization_id","team_id","roster_member_id") REFERENCES "app"."roster_members"("organization_id","team_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contracts" ADD CONSTRAINT "contracts_game_fk" FOREIGN KEY ("organization_id","game_id") REFERENCES "app"."games"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_settings" ADD CONSTRAINT "document_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_settings" ADD CONSTRAINT "document_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_settings" ADD CONSTRAINT "document_settings_logo_fk" FOREIGN KEY ("organization_id","logo_file_id") REFERENCES "app"."stored_files"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_settings" ADD CONSTRAINT "document_settings_background_fk" FOREIGN KEY ("organization_id","background_file_id") REFERENCES "app"."stored_files"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_settings" ADD CONSTRAINT "document_settings_stamp_fk" FOREIGN KEY ("organization_id","stamp_file_id") REFERENCES "app"."stored_files"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entity_versions" ADD CONSTRAINT "entity_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entity_versions" ADD CONSTRAINT "entity_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stored_files" ADD CONSTRAINT "stored_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stored_files" ADD CONSTRAINT "stored_files_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."template_clauses" ADD CONSTRAINT "template_clauses_type_fk" FOREIGN KEY ("organization_id","contract_type_id") REFERENCES "app"."contract_types"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending" ON "app"."approval_requests" USING btree ("contract_id") WHERE "app"."approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_requests_org_status_idx" ON "app"."approval_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "clause_proposals_contract_idx" ON "app"."clause_proposals" USING btree ("contract_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_types_org_key_unique" ON "app"."contract_types" USING btree ("organization_id","key") WHERE "app"."contract_types"."key" is not null;--> statement-breakpoint
CREATE INDEX "contracts_org_status_idx" ON "app"."contracts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "entity_versions_entity_idx" ON "app"."entity_versions" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "template_clauses_type_idx" ON "app"."template_clauses" USING btree ("contract_type_id","position");