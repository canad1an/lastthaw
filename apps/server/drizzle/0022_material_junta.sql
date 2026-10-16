CREATE TABLE "session_sightings" (
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"ip" text NOT NULL,
	"user_agent" text,
	CONSTRAINT "session_sightings_session_id_hour_pk" PRIMARY KEY("session_id","hour")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspend_reason" text;--> statement-breakpoint
ALTER TABLE "session_sightings" ADD CONSTRAINT "session_sightings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_sightings" ADD CONSTRAINT "session_sightings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sightings_ip_idx" ON "session_sightings" USING btree ("ip","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_name_idx" ON "users" USING btree (lower("display_name"));