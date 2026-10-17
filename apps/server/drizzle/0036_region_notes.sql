CREATE TABLE "region_notes" (
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"region_id" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"colour" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_notes_match_id_player_id_region_id_pk" PRIMARY KEY("match_id","player_id","region_id")
);
--> statement-breakpoint
ALTER TABLE "region_notes" ADD CONSTRAINT "region_notes_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region_notes" ADD CONSTRAINT "region_notes_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;