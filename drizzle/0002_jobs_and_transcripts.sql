CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('clean', 'transcribe');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sermon_id" uuid NOT NULL,
	"type" "job_type" NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_by" text,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sermon_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"model" text NOT NULL,
	"language" text NOT NULL,
	"full_text" text NOT NULL,
	"segments" jsonb NOT NULL,
	"low_confidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"info" jsonb
);
--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "duration_sec" integer;--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "failed_stage" text;--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sermon_id_sermons_id_fk" FOREIGN KEY ("sermon_id") REFERENCES "public"."sermons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_sermon_id_sermons_id_fk" FOREIGN KEY ("sermon_id") REFERENCES "public"."sermons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("state","run_after");--> statement-breakpoint
CREATE INDEX "jobs_sermon_idx" ON "jobs" USING btree ("sermon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_active_idx" ON "jobs" USING btree ("sermon_id","type") WHERE "jobs"."state" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_sermon_version_idx" ON "transcripts" USING btree ("sermon_id","version");--> statement-breakpoint
ALTER TABLE "sermons" ADD CONSTRAINT "sermons_failed_stage_check" CHECK ("sermons"."failed_stage" is null or "sermons"."failed_stage" in ('cleaning', 'transcribing', 'analyzing'));