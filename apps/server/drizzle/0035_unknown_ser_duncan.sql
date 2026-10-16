CREATE TABLE "player_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_actions" ADD CONSTRAINT "player_actions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_actions" ADD CONSTRAINT "player_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_actions_user_idx" ON "player_actions" USING btree ("user_id","match_id","at");--> statement-breakpoint
CREATE INDEX "player_actions_at_idx" ON "player_actions" USING btree ("at");