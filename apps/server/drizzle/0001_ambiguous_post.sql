CREATE TYPE "public"."job_kind" AS ENUM('build', 'research', 'train', 'mission', 'ice_step', 'win_hold', 'match_end');--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid,
	"region_id" text,
	"kind" "job_kind" NOT NULL,
	"ref_id" text,
	"level" integer,
	"qty" integer,
	"slot" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_regions" (
	"match_id" uuid NOT NULL,
	"region_id" text NOT NULL,
	"owner_player_id" uuid,
	"pop_workers" double precision DEFAULT 0 NOT NULL,
	"pop_soldiers" double precision DEFAULT 0 NOT NULL,
	"pop_occupiers" double precision DEFAULT 0 NOT NULL,
	"food" double precision DEFAULT 0 NOT NULL,
	"wood" double precision DEFAULT 0 NOT NULL,
	"stone" double precision DEFAULT 0 NOT NULL,
	"assignment" jsonb NOT NULL,
	"storage_level" integer DEFAULT 0 NOT NULL,
	"buildings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"loyalty" double precision DEFAULT 1 NOT NULL,
	"frozen_at" timestamp with time zone,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_regions_match_id_region_id_pk" PRIMARY KEY("match_id","region_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "region_sightings" (
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"region_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "region_sightings_match_id_player_id_region_id_pk" PRIMARY KEY("match_id","player_id","region_id")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_regions" ADD CONSTRAINT "match_regions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_regions" ADD CONSTRAINT "match_regions_owner_player_id_players_id_fk" FOREIGN KEY ("owner_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region_sightings" ADD CONSTRAINT "region_sightings_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region_sightings" ADD CONSTRAINT "region_sightings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_match_idx" ON "events" USING btree ("match_id","at");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("ends_at") WHERE completed_at is null and cancelled_at is null;--> statement-breakpoint
CREATE INDEX "jobs_region_idx" ON "jobs" USING btree ("match_id","region_id");--> statement-breakpoint
CREATE INDEX "match_regions_owner_idx" ON "match_regions" USING btree ("match_id","owner_player_id");--> statement-breakpoint
CREATE INDEX "messages_player_idx" ON "messages" USING btree ("player_id","read_at");