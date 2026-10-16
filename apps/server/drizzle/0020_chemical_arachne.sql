CREATE TABLE "ownership_frames" (
	"match_id" uuid NOT NULL,
	"day" real NOT NULL,
	"changes" jsonb NOT NULL,
	CONSTRAINT "ownership_frames_match_id_day_pk" PRIMARY KEY("match_id","day")
);
--> statement-breakpoint
CREATE TABLE "ownership_latest" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"owners" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_history" (
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"day" real NOT NULL,
	"score" integer NOT NULL,
	"regions" integer NOT NULL,
	"population" integer NOT NULL,
	CONSTRAINT "score_history_match_id_player_id_day_pk" PRIMARY KEY("match_id","player_id","day")
);
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "win_kind" text;--> statement-breakpoint
ALTER TABLE "ownership_frames" ADD CONSTRAINT "ownership_frames_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_latest" ADD CONSTRAINT "ownership_latest_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_history" ADD CONSTRAINT "score_history_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_history" ADD CONSTRAINT "score_history_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;