ALTER TYPE "public"."mission_kind" ADD VALUE 'expedition';--> statement-breakpoint
CREATE TABLE "mercenary_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"company" text NOT NULL,
	"unit_id" text NOT NULL,
	"qty" integer NOT NULL,
	"iron" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"hired_by" uuid,
	"hired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"a_player_id" uuid NOT NULL,
	"b_player_id" uuid NOT NULL,
	"proposed_by" uuid NOT NULL,
	"status" text NOT NULL,
	"until" timestamp with time zone,
	"terms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "loyalty_boost_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "last_stand_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mercenary_offers" ADD CONSTRAINT "mercenary_offers_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pacts" ADD CONSTRAINT "pacts_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pacts" ADD CONSTRAINT "pacts_a_player_id_players_id_fk" FOREIGN KEY ("a_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pacts" ADD CONSTRAINT "pacts_b_player_id_players_id_fk" FOREIGN KEY ("b_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mercs_match_idx" ON "mercenary_offers" USING btree ("match_id","expires_at");--> statement-breakpoint
CREATE INDEX "pacts_match_idx" ON "pacts" USING btree ("match_id","status");