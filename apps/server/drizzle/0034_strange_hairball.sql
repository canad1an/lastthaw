CREATE TABLE "tribe_chat_posts" (
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"day" integer NOT NULL,
	"kind" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tribe_chat_posts_match_id_player_id_day_kind_pk" PRIMARY KEY("match_id","player_id","day","kind")
);
--> statement-breakpoint
ALTER TABLE "tribe_chat_posts" ADD CONSTRAINT "tribe_chat_posts_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tribe_chat_posts" ADD CONSTRAINT "tribe_chat_posts_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;