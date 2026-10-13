ALTER TYPE "public"."sermon_status" ADD VALUE 'needs_audio' BEFORE 'approved';--> statement-breakpoint
DROP INDEX "audio_assets_one_original_idx";--> statement-breakpoint
ALTER TABLE "audio_assets" ADD COLUMN "set_aside_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sermons" ADD COLUMN "audio_rejected_reason" text;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "replaces_audio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_assets_one_original_idx" ON "audio_assets" USING btree ("sermon_id") WHERE "audio_assets"."kind" = 'original' and "audio_assets"."set_aside_at" is null;