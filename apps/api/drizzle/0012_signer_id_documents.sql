CREATE TABLE "app"."signer_id_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"signer_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_via_link_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "signer_id_documents_org_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."contract_signers" ADD COLUMN "id_document_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."signer_id_documents" ADD CONSTRAINT "signer_id_documents_uploaded_via_link_id_signing_links_id_fk" FOREIGN KEY ("uploaded_via_link_id") REFERENCES "app"."signing_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signer_id_documents" ADD CONSTRAINT "signer_id_documents_round_fk" FOREIGN KEY ("organization_id","round_id") REFERENCES "app"."signing_rounds"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signer_id_documents" ADD CONSTRAINT "signer_id_documents_signer_fk" FOREIGN KEY ("organization_id","signer_id") REFERENCES "app"."contract_signers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."signer_id_documents" ADD CONSTRAINT "signer_id_documents_file_fk" FOREIGN KEY ("organization_id","file_id") REFERENCES "app"."stored_files"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signer_id_documents_one_current" ON "app"."signer_id_documents" USING btree ("signer_id") WHERE "app"."signer_id_documents"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "signer_id_documents_round_idx" ON "app"."signer_id_documents" USING btree ("round_id");