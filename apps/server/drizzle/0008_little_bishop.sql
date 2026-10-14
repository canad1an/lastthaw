CREATE TYPE "public"."trade_route_mode" AS ENUM('fixed', 'share');--> statement-breakpoint
CREATE TABLE "trade_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"from_region_id" text NOT NULL,
	"to_region_id" text NOT NULL,
	"mode" "trade_route_mode" DEFAULT 'fixed' NOT NULL,
	"load" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"share" double precision DEFAULT 0 NOT NULL,
	"caravans" integer DEFAULT 1 NOT NULL,
	"every_hours" double precision DEFAULT 2 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_routes" ADD CONSTRAINT "trade_routes_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_routes" ADD CONSTRAINT "trade_routes_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trade_routes_due_idx" ON "trade_routes" USING btree ("next_at");--> statement-breakpoint
CREATE INDEX "trade_routes_from_idx" ON "trade_routes" USING btree ("match_id","from_region_id");--> statement-breakpoint
ALTER TABLE "match_regions" DROP COLUMN "tribute_share";