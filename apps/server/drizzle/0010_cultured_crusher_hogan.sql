ALTER TABLE "trade_routes" ADD COLUMN "target" jsonb;--> statement-breakpoint
ALTER TABLE "trade_routes" ADD COLUMN "delivered" jsonb DEFAULT '{}'::jsonb NOT NULL;