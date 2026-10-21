CREATE TABLE "advisor_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"region_id" text,
	"text" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "advisor_events" ADD CONSTRAINT "advisor_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_events" ADD CONSTRAINT "advisor_events_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "advisor_events_player_idx" ON "advisor_events" USING btree ("match_id","player_id","kind","at");