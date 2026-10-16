CREATE TABLE "bounties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"region_id" text,
	"player_id" uuid,
	"amount" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "daily_objectives" (
	"match_id" uuid NOT NULL,
	"day" integer NOT NULL,
	"key" text NOT NULL,
	"winner_player_id" uuid,
	"value" integer,
	CONSTRAINT "daily_objectives_match_id_day_pk" PRIMARY KEY("match_id","day")
);
--> statement-breakpoint
ALTER TABLE "user_match_results" ADD COLUMN "win_kind" text;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_objectives" ADD CONSTRAINT "daily_objectives_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bounties_match_idx" ON "bounties" USING btree ("match_id","claimed_by");