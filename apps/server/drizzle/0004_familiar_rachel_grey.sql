CREATE TABLE "user_match_results" (
	"user_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"final_rank" integer NOT NULL,
	"score" integer NOT NULL,
	"regions_held" integer NOT NULL,
	"age_reached" integer NOT NULL,
	"eliminated_at" timestamp with time zone,
	"won" boolean DEFAULT false NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_match_results_user_id_match_id_pk" PRIMARY KEY("user_id","match_id")
);
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "last_tick_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_match_results" ADD CONSTRAINT "user_match_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;