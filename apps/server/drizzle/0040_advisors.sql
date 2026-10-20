CREATE TABLE "advisors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"hired_at" timestamp with time zone NOT NULL,
	"paid_until" timestamp with time zone NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_pass_at" timestamp with time zone,
	"last_report" jsonb,
	"unpaid_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "advisors" ADD CONSTRAINT "advisors_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisors" ADD CONSTRAINT "advisors_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "advisors_player_kind_idx" ON "advisors" USING btree ("match_id","player_id","kind");