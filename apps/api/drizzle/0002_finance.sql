CREATE TABLE "app"."budget_lines" (
	"budget_id" uuid NOT NULL,
	"category" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"over_alerted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "budget_lines_pk" PRIMARY KEY("budget_id","category")
);
--> statement-breakpoint
CREATE TABLE "app"."budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"team_id" uuid,
	"tournament_id" uuid,
	"season_id" uuid,
	"period_start" date,
	"period_end" date,
	"currency" text NOT NULL,
	"total" numeric(18, 4) NOT NULL,
	"notes" text,
	"total_over_alerted" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."finance_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"team_id" uuid,
	"roster_member_id" uuid,
	"tournament_id" uuid,
	"season_id" uuid,
	"category" text NOT NULL,
	"description" text,
	"entry_date" date NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency" text NOT NULL,
	"fx_rate" numeric(24, 12) NOT NULL,
	"fx_rate_date" date,
	"fx_source" text NOT NULL,
	"base_currency" text NOT NULL,
	"base_amount" numeric(18, 4) NOT NULL,
	"recurrence" text DEFAULT 'one_time' NOT NULL,
	"ownership" text,
	"realized" boolean DEFAULT true NOT NULL,
	"certainty" text,
	"counterparty" text,
	"tax_amount" numeric(18, 4),
	"tax_jurisdiction" text,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_entries_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "finance_entries_player_needs_team" CHECK ("app"."finance_entries"."roster_member_id" is null or "app"."finance_entries"."team_id" is not null),
	CONSTRAINT "finance_entries_kind_fields" CHECK (("app"."finance_entries"."kind" = 'expense' and "app"."finance_entries"."realized" and "app"."finance_entries"."certainty" is null)
       or ("app"."finance_entries"."kind" = 'revenue' and "app"."finance_entries"."certainty" is not null and "app"."finance_entries"."ownership" is null)),
	CONSTRAINT "finance_entries_amount_positive" CHECK ("app"."finance_entries"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."finance_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" uuid,
	"scenarios" jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_scenarios_scope_unique" UNIQUE NULLS NOT DISTINCT("organization_id","scope_kind","scope_id")
);
--> statement-breakpoint
CREATE TABLE "app"."fx_rates" (
	"source" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"requested_date" date NOT NULL,
	"rate_date" date NOT NULL,
	"rate" numeric(24, 12) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_pk" PRIMARY KEY("source","base","quote","requested_date")
);
--> statement-breakpoint
CREATE TABLE "app"."roster_compensation" (
	"roster_member_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"off_season_amount" numeric(18, 4),
	"frequency" text NOT NULL,
	"contract_start" date,
	"contract_end" date,
	"signing_bonus" numeric(18, 4),
	"notes" text,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."roster_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"handle" text,
	"role" text NOT NULL,
	"position" text,
	"nationality" text,
	"date_of_birth" date,
	"email" text,
	"phone" text,
	"joined_on" date,
	"left_on" date,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_members_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "roster_members_org_team_id_unique" UNIQUE("organization_id","team_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seasons_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "seasons_dates" CHECK ("app"."seasons"."start_date" <= "app"."seasons"."end_date")
);
--> statement-breakpoint
CREATE TABLE "app"."tournament_teams" (
	"organization_id" uuid NOT NULL,
	"tournament_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "tournament_teams_pk" PRIMARY KEY("tournament_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "app"."tournaments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"organizer" text,
	"game_id" uuid,
	"region" text,
	"start_date" date,
	"end_date" date,
	"status" text DEFAULT 'researching' NOT NULL,
	"eligibility" text,
	"qualification" text,
	"entry_fee_amount" numeric(18, 4),
	"entry_fee_currency" text,
	"prize_pool_amount" numeric(18, 4),
	"prize_pool_currency" text,
	"placement_rewards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"travel_requirements" text,
	"historical_results" text,
	"sponsor_coverage" text,
	"source_url" text,
	"last_verified_on" date,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournaments_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."organizations" ADD COLUMN "base_currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."organizations" ADD COLUMN "enabled_currencies" text[] DEFAULT '{USD,SAR}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."budget_lines" ADD CONSTRAINT "budget_lines_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "app"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."budgets" ADD CONSTRAINT "budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."budgets" ADD CONSTRAINT "budgets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."budgets" ADD CONSTRAINT "budgets_team_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "app"."teams"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."budgets" ADD CONSTRAINT "budgets_tournament_fk" FOREIGN KEY ("organization_id","tournament_id") REFERENCES "app"."tournaments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."budgets" ADD CONSTRAINT "budgets_season_fk" FOREIGN KEY ("organization_id","season_id") REFERENCES "app"."seasons"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."finance_entries" ADD CONSTRAINT "finance_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."finance_entries" ADD CONSTRAINT "finance_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."finance_entries" ADD CONSTRAINT "finance_entries_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."finance_entries" ADD CONSTRAINT "finance_entries_team_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "app"."teams"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."finance_entries" ADD CONSTRAINT "finance_entries_member_fk" FOREIGN KEY ("organization_id","team_id","roster_member_id") REFERENCES "app"."roster_members"("organization_id","team_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."finance_entries" ADD CONSTRAINT "finance_entries_tournament_fk" FOREIGN KEY ("organization_id","tournament_id") REFERENCES "app"."tournaments"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."finance_entries" ADD CONSTRAINT "finance_entries_season_fk" FOREIGN KEY ("organization_id","season_id") REFERENCES "app"."seasons"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."finance_scenarios" ADD CONSTRAINT "finance_scenarios_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."finance_scenarios" ADD CONSTRAINT "finance_scenarios_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."roster_compensation" ADD CONSTRAINT "roster_compensation_roster_member_id_roster_members_id_fk" FOREIGN KEY ("roster_member_id") REFERENCES "app"."roster_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."roster_compensation" ADD CONSTRAINT "roster_compensation_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."roster_compensation" ADD CONSTRAINT "roster_compensation_member_fk" FOREIGN KEY ("organization_id","roster_member_id") REFERENCES "app"."roster_members"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."roster_members" ADD CONSTRAINT "roster_members_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."roster_members" ADD CONSTRAINT "roster_members_team_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "app"."teams"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."seasons" ADD CONSTRAINT "seasons_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tournament_teams" ADD CONSTRAINT "tournament_teams_tournament_fk" FOREIGN KEY ("organization_id","tournament_id") REFERENCES "app"."tournaments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tournament_teams" ADD CONSTRAINT "tournament_teams_team_fk" FOREIGN KEY ("organization_id","team_id") REFERENCES "app"."teams"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD CONSTRAINT "tournaments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD CONSTRAINT "tournaments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tournaments" ADD CONSTRAINT "tournaments_game_fk" FOREIGN KEY ("organization_id","game_id") REFERENCES "app"."games"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_entries_org_date_idx" ON "app"."finance_entries" USING btree ("organization_id","entry_date");--> statement-breakpoint
CREATE INDEX "finance_entries_team_idx" ON "app"."finance_entries" USING btree ("organization_id","team_id");--> statement-breakpoint
CREATE INDEX "finance_entries_tournament_idx" ON "app"."finance_entries" USING btree ("organization_id","tournament_id");--> statement-breakpoint
CREATE INDEX "finance_entries_season_idx" ON "app"."finance_entries" USING btree ("organization_id","season_id");--> statement-breakpoint
CREATE INDEX "roster_members_team_idx" ON "app"."roster_members" USING btree ("organization_id","team_id");