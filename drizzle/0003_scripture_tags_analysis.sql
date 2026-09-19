CREATE TYPE "public"."ref_source" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."tag_kind" AS ENUM('testament', 'genre', 'book', 'topic');--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'analyze';--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sermon_id" uuid NOT NULL,
	"transcript_version" integer NOT NULL,
	"analyzer" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"raw_output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scripture_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sermon_id" uuid NOT NULL,
	"book" text NOT NULL,
	"chapter" integer NOT NULL,
	"verse_start" integer,
	"verse_end" integer,
	"spoken_at_sec" real NOT NULL,
	"context_note" text,
	"is_main_text" boolean DEFAULT false NOT NULL,
	"source" "ref_source" NOT NULL,
	"confidence" real,
	"detected_original" jsonb,
	"edited_by" uuid,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scripture_refs_chapter_check" CHECK ("scripture_refs"."chapter" >= 1),
	CONSTRAINT "scripture_refs_verses_check" CHECK (("scripture_refs"."verse_start" is null and "scripture_refs"."verse_end" is null) or ("scripture_refs"."verse_start" >= 1 and ("scripture_refs"."verse_end" is null or "scripture_refs"."verse_end" >= "scripture_refs"."verse_start")))
);
--> statement-breakpoint
CREATE TABLE "sermon_tags" (
	"sermon_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "sermon_tags_sermon_id_tag_id_pk" PRIMARY KEY("sermon_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "tag_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "filename_stem" text;--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "summary_text" text;--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "summary_source" text;--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "primary_passage" jsonb;--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_sermon_id_sermons_id_fk" FOREIGN KEY ("sermon_id") REFERENCES "public"."sermons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripture_refs" ADD CONSTRAINT "scripture_refs_sermon_id_sermons_id_fk" FOREIGN KEY ("sermon_id") REFERENCES "public"."sermons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripture_refs" ADD CONSTRAINT "scripture_refs_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sermon_tags" ADD CONSTRAINT "sermon_tags_sermon_id_sermons_id_fk" FOREIGN KEY ("sermon_id") REFERENCES "public"."sermons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sermon_tags" ADD CONSTRAINT "sermon_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_sermon_idx" ON "analyses" USING btree ("sermon_id");--> statement-breakpoint
CREATE INDEX "scripture_refs_sermon_idx" ON "scripture_refs" USING btree ("sermon_id");--> statement-breakpoint
CREATE INDEX "sermon_tags_tag_idx" ON "sermon_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_kind_name_idx" ON "tags" USING btree ("kind",lower("name"));--> statement-breakpoint
ALTER TABLE "sermons" ADD CONSTRAINT "sermons_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sermons_filename_stem_idx" ON "sermons" USING btree ("filename_stem") WHERE "sermons"."deleted_at" is null and "sermons"."filename_stem" is not null;--> statement-breakpoint
ALTER TABLE "sermons" ADD CONSTRAINT "sermons_summary_source_check" CHECK ("sermons"."summary_source" is null or "sermons"."summary_source" in ('auto', 'edited'));