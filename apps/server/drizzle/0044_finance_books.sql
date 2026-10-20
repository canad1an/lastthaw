CREATE TABLE "economy_history" (
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"day" real NOT NULL,
	"gross" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"eaten" jsonb DEFAULT '{"people":0,"soldiers":0}'::jsonb NOT NULL,
	"regions" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "economy_history_match_id_player_id_day_pk" PRIMARY KEY("match_id","player_id","day")
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"day" integer NOT NULL,
	"category" text NOT NULL,
	"resource" text NOT NULL,
	"amount" real DEFAULT 0 NOT NULL,
	CONSTRAINT "spend_ledger_match_id_player_id_day_category_resource_pk" PRIMARY KEY("match_id","player_id","day","category","resource")
);
--> statement-breakpoint
ALTER TABLE "economy_history" ADD CONSTRAINT "economy_history_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economy_history" ADD CONSTRAINT "economy_history_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;