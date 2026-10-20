ALTER TYPE "public"."army_status" ADD VALUE 'fighting';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'battle_round';--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "total_rounds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "next_round_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "army_id" uuid;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "live" jsonb;--> statement-breakpoint
ALTER TABLE "battles" ADD COLUMN "outcome" jsonb;--> statement-breakpoint
CREATE INDEX "battles_live_idx" ON "battles" USING btree ("match_id","status");