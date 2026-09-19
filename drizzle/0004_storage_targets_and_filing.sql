CREATE TYPE "public"."storage_object_state" AS ENUM('uploaded', 'verified', 'drifted', 'missing');--> statement-breakpoint
CREATE TYPE "public"."storage_role" AS ENUM('shared', 'backup');--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'file';--> statement-breakpoint
CREATE TABLE "storage_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sermon_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"remote_id" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"remote_checksum" text NOT NULL,
	"checksum_algorithm" text NOT NULL,
	"state" "storage_object_state" DEFAULT 'uploaded' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "storage_role" NOT NULL,
	"provider" text NOT NULL,
	"encrypted_config" text,
	"account_label" text,
	"root_folder_name" text NOT NULL,
	"root_folder_id" text,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_targets_role_unique" UNIQUE("role")
);
--> statement-breakpoint
CREATE TABLE "verification_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"requested_by" uuid,
	"state" text DEFAULT 'queued' NOT NULL,
	"checked" integer,
	"verified" integer,
	"drifted" integer,
	"missing" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "verification_runs_state_check" CHECK ("verification_runs"."state" in ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "verification_runs_trigger_check" CHECK ("verification_runs"."trigger" in ('manual', 'nightly'))
);
--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "filed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "filing_error" text;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_sermon_id_sermons_id_fk" FOREIGN KEY ("sermon_id") REFERENCES "public"."sermons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_target_id_storage_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."storage_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_targets" ADD CONSTRAINT "storage_targets_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_objects_target_path_idx" ON "storage_objects" USING btree ("target_id","path");--> statement-breakpoint
CREATE INDEX "storage_objects_sermon_idx" ON "storage_objects" USING btree ("sermon_id");--> statement-breakpoint
CREATE INDEX "storage_objects_state_idx" ON "storage_objects" USING btree ("state");--> statement-breakpoint
CREATE INDEX "verification_runs_created_idx" ON "verification_runs" USING btree ("created_at");