CREATE TABLE "app"."contract_signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"role" text NOT NULL,
	"sign_order" integer NOT NULL,
	"name_en" text,
	"name_ar" text,
	"email" text,
	"phone" text,
	"relationship" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_via_link_id" uuid,
	"verification_method" text,
	"verification_destination" text,
	"verified_at" timestamp with time zone,
	"signature_method" text,
	"typed_name" text,
	"font_key" text,
	"strokes" jsonb,
	"consent_version" text,
	"consent_locale" text,
	"consent_text" text,
	"document_sha256" text,
	"record_sha256" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_signers_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "contract_signers_round_role_unique" UNIQUE("round_id","role"),
	CONSTRAINT "contract_signers_signed_record" CHECK ("app"."contract_signers"."status" <> 'signed' or ("app"."contract_signers"."signed_at" is not null and "app"."contract_signers"."signature_method" is not null and "app"."contract_signers"."consent_text" is not null and "app"."contract_signers"."document_sha256" is not null and "app"."contract_signers"."verified_at" is not null and "app"."contract_signers"."record_sha256" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."signing_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"signer_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"method" text NOT NULL,
	"destination" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revoke_reason" text,
	"used_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"access_code_hash" text,
	"email_code_hash" text,
	"email_code_expires_at" timestamp with time zone,
	"email_codes_sent" integer DEFAULT 0 NOT NULL,
	"last_code_sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	CONSTRAINT "signing_links_token_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "app"."signing_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"minor" boolean NOT NULL,
	"minor_on" text NOT NULL,
	"approved_document_sha256" text NOT NULL,
	"started_by_user_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"signed_document_file_id" uuid,
	"signed_document_sha256" text,
	CONSTRAINT "signing_rounds_org_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "signing_rounds_completed_document" CHECK ("app"."signing_rounds"."status" <> 'completed' or ("app"."signing_rounds"."signed_document_file_id" is not null and "app"."signing_rounds"."completed_at" is not null)),
	CONSTRAINT "signing_rounds_cancel_reason" CHECK ("app"."signing_rounds"."status" <> 'cancelled' or ("app"."signing_rounds"."cancel_reason" is not null and length(trim("app"."signing_rounds"."cancel_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "app"."contract_signers" ADD CONSTRAINT "contract_signers_round_fk" FOREIGN KEY ("organization_id","round_id") REFERENCES "app"."signing_rounds"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signing_links" ADD CONSTRAINT "signing_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signing_links" ADD CONSTRAINT "signing_links_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signing_links" ADD CONSTRAINT "signing_links_signer_fk" FOREIGN KEY ("organization_id","signer_id") REFERENCES "app"."contract_signers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signing_rounds" ADD CONSTRAINT "signing_rounds_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signing_rounds" ADD CONSTRAINT "signing_rounds_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signing_rounds" ADD CONSTRAINT "signing_rounds_contract_fk" FOREIGN KEY ("organization_id","contract_id") REFERENCES "app"."contracts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signing_rounds" ADD CONSTRAINT "signing_rounds_approval_fk" FOREIGN KEY ("organization_id","approval_request_id") REFERENCES "app"."approval_requests"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signing_rounds" ADD CONSTRAINT "signing_rounds_document_fk" FOREIGN KEY ("organization_id","signed_document_file_id") REFERENCES "app"."stored_files"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signing_links_signer_idx" ON "app"."signing_links" USING btree ("signer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_rounds_one_open" ON "app"."signing_rounds" USING btree ("contract_id") WHERE "app"."signing_rounds"."status" = 'in_progress';