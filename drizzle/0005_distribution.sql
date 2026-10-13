CREATE TYPE "public"."channel_kind" AS ENUM('youtube', 'podcast');--> statement-breakpoint
CREATE TYPE "public"."publication_state" AS ENUM('queued', 'publishing', 'published', 'failed', 'removing', 'removed');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('private', 'unlisted', 'public');--> statement-breakpoint
CREATE TABLE "distribution_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"provider" text NOT NULL,
	"encrypted_config" text,
	"account_label" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"artwork_key" text,
	"artwork_for" text,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_channels_kind_unique" UNIQUE("kind")
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sermon_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"state" "publication_state" DEFAULT 'queued' NOT NULL,
	"visibility" "visibility" NOT NULL,
	"remote_visibility" "visibility",
	"remote_id" text,
	"remote_url" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"captions_id" text,
	"upload_session" text,
	"uploaded_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"error_detail" text,
	"locked_by" text,
	"heartbeat_at" timestamp with time zone,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_published_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"removed_by" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "distribution_channels" ADD CONSTRAINT "distribution_channels_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_sermon_id_sermons_id_fk" FOREIGN KEY ("sermon_id") REFERENCES "public"."sermons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_channel_id_distribution_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."distribution_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publications_sermon_channel_idx" ON "publications" USING btree ("sermon_id","channel_id");--> statement-breakpoint
CREATE INDEX "publications_claim_idx" ON "publications" USING btree ("state","run_after");--> statement-breakpoint
CREATE INDEX "publications_channel_state_idx" ON "publications" USING btree ("channel_id","state");