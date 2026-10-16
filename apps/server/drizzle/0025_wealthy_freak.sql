ALTER TYPE "public"."job_kind" ADD VALUE 'storm';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'merc_expire';--> statement-breakpoint
CREATE TABLE "refugee_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"region_id" text NOT NULL,
	"from_region_id" text NOT NULL,
	"people" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"accepted" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_regions" ADD COLUMN "storm_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "match_regions" ADD COLUMN "plague_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "match_regions" ADD COLUMN "thaw_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "match_regions" ADD COLUMN "boom" jsonb;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "refugee_offers" ADD CONSTRAINT "refugee_offers_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refugee_offers" ADD CONSTRAINT "refugee_offers_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refugees_player_idx" ON "refugee_offers" USING btree ("player_id","decided_at");