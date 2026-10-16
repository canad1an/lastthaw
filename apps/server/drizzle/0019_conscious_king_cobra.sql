CREATE TABLE "match_milestones" (
	"match_id" uuid NOT NULL,
	"key" text NOT NULL,
	"player_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "match_milestones_match_id_key_pk" PRIMARY KEY("match_id","key")
);
--> statement-breakpoint
ALTER TABLE "match_milestones" ADD CONSTRAINT "match_milestones_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_milestones" ADD CONSTRAINT "match_milestones_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;