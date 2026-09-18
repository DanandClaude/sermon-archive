CREATE TYPE "public"."audio_kind" AS ENUM('original', 'cleaned', 'video_render');--> statement-breakpoint
CREATE TYPE "public"."date_source" AS ENUM('label', 'audio', 'manual');--> statement-breakpoint
CREATE TYPE "public"."sermon_status" AS ENUM('uploading', 'uploaded', 'cleaning', 'transcribing', 'analyzing', 'needs_review', 'approved', 'filing', 'filed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('in_progress', 'completed', 'aborted');--> statement-breakpoint
CREATE TABLE "audio_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sermon_id" uuid NOT NULL,
	"kind" "audio_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"mime" text NOT NULL,
	"original_filename" text NOT NULL,
	"duration_sec" integer,
	"peaks_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "login_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sermons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "sermon_status" DEFAULT 'uploading' NOT NULL,
	"title" text,
	"recorded_on" date,
	"date_source" date_source,
	"speaker" text,
	"batch_label" text,
	"side" text,
	"label_scripture" text,
	"contributor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sermons_side_check" CHECK ("sermons"."side" in ('A', 'B'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sermon_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"store_upload_id" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime" text NOT NULL,
	"fingerprint" text NOT NULL,
	"part_size" integer NOT NULL,
	"status" "upload_status" DEFAULT 'in_progress' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "uploads_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audio_assets" ADD CONSTRAINT "audio_assets_sermon_id_sermons_id_fk" FOREIGN KEY ("sermon_id") REFERENCES "public"."sermons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sermons" ADD CONSTRAINT "sermons_contributor_id_users_id_fk" FOREIGN KEY ("contributor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_sermon_id_sermons_id_fk" FOREIGN KEY ("sermon_id") REFERENCES "public"."sermons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_assets_sermon_idx" ON "audio_assets" USING btree ("sermon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_assets_one_original_idx" ON "audio_assets" USING btree ("sermon_id") WHERE "audio_assets"."kind" = 'original';--> statement-breakpoint
CREATE INDEX "login_tokens_user_idx" ON "login_tokens" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "sermons_status_idx" ON "sermons" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sermons_contributor_idx" ON "sermons" USING btree ("contributor_id");--> statement-breakpoint
CREATE INDEX "sermons_recorded_on_idx" ON "sermons" USING btree ("recorded_on");--> statement-breakpoint
CREATE INDEX "sermons_created_at_idx" ON "sermons" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uploads_resume_idx" ON "uploads" USING btree ("user_id","fingerprint") WHERE "uploads"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "uploads_sermon_idx" ON "uploads" USING btree ("sermon_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;