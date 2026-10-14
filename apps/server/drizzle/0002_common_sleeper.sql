CREATE TABLE "player_techs" (
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"tech_id" text NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "player_techs_player_id_tech_id_pk" PRIMARY KEY("player_id","tech_id")
);
--> statement-breakpoint
ALTER TABLE "match_regions" ADD COLUMN "special" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "match_regions" ADD COLUMN "units" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "player_techs" ADD CONSTRAINT "player_techs_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_techs" ADD CONSTRAINT "player_techs_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;