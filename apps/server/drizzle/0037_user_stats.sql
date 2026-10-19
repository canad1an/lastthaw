CREATE TABLE "user_stats" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"seconds_online" integer DEFAULT 0 NOT NULL,
	"longest_session_seconds" integer DEFAULT 0 NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"logins" integer DEFAULT 0 NOT NULL,
	"devices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_stats" ADD CONSTRAINT "user_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;