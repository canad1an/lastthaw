CREATE TABLE "fairplay_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_a" uuid NOT NULL,
	"user_b" uuid NOT NULL,
	"match_id" uuid,
	"reason" text NOT NULL,
	"score" integer DEFAULT 1 NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"verdict" text
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fairplay_pair_idx" ON "fairplay_flags" USING btree ("user_a","user_b","match_id","reason");--> statement-breakpoint
CREATE INDEX "fairplay_open_idx" ON "fairplay_flags" USING btree ("reviewed_at");--> statement-breakpoint
CREATE INDEX "sessions_ip_idx" ON "sessions" USING btree ("ip");