ALTER TABLE "jobs" ADD COLUMN "waiting_for" jsonb;--> statement-breakpoint
ALTER TABLE "trade_routes" ADD COLUMN "for_job_id" uuid;