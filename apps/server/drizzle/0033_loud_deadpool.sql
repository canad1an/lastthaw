CREATE TABLE "discord_posts" (
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"day" integer NOT NULL,
	"body" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discord_posts_match_id_player_id_day_pk" PRIMARY KEY("match_id","player_id","day")
);
--> statement-breakpoint
ALTER TABLE "discord_posts" ADD CONSTRAINT "discord_posts_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_posts" ADD CONSTRAINT "discord_posts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;