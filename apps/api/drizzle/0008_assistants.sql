CREATE TABLE "app"."ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"assistant" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"reply_language" text DEFAULT 'auto' NOT NULL,
	"web_search" boolean DEFAULT false NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_conversations_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"language" text,
	"text" text,
	"answer" jsonb,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"provider" text,
	"model" text,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ai_messages_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "ai_messages_conversation_seq_unique" UNIQUE("conversation_id","seq"),
	CONSTRAINT "ai_messages_complete_answer" CHECK ("app"."ai_messages"."role" <> 'assistant' or "app"."ai_messages"."status" <> 'complete' or "app"."ai_messages"."answer" is not null),
	CONSTRAINT "ai_messages_user_text" CHECK ("app"."ai_messages"."role" <> 'user' or "app"."ai_messages"."text" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."ai_proposal_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."ai_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"assistant" text NOT NULL,
	"tool" text NOT NULL,
	"kind" text NOT NULL,
	"input" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"result_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."ai_conversations" ADD CONSTRAINT "ai_conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_messages" ADD CONSTRAINT "ai_messages_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "app"."ai_conversations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_proposal_actions" ADD CONSTRAINT "ai_proposal_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_proposal_actions" ADD CONSTRAINT "ai_proposal_actions_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "app"."ai_messages"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "app"."ai_messages"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversations_owner_idx" ON "app"."ai_conversations" USING btree ("organization_id","user_id","assistant","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_one_pending" ON "app"."ai_messages" USING btree ("conversation_id") WHERE "app"."ai_messages"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ai_proposal_actions_message_idx" ON "app"."ai_proposal_actions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_org_time_idx" ON "app"."ai_tool_calls" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_message_idx" ON "app"."ai_tool_calls" USING btree ("message_id");