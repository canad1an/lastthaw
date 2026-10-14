CREATE TYPE "public"."army_status" AS ENUM('outbound', 'returning', 'done');--> statement-breakpoint
CREATE TYPE "public"."mission_kind" AS ENUM('raid', 'conquer', 'reinforce', 'move', 'transport', 'scout');--> statement-breakpoint
CREATE TABLE "alliance_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"alliance_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alliance_members" (
	"match_id" uuid NOT NULL,
	"alliance_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alliance_members_player_id_pk" PRIMARY KEY("player_id")
);
--> statement-breakpoint
CREATE TABLE "alliances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"leader_player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "armies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"mission" "mission_kind" NOT NULL,
	"origin_region_id" text NOT NULL,
	"target_region_id" text NOT NULL,
	"units" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cargo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "army_status" DEFAULT 'outbound' NOT NULL,
	"departs_at" timestamp with time zone NOT NULL,
	"arrives_at" timestamp with time zone NOT NULL,
	"returns_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "battles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"region_id" text NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL,
	"seed" text NOT NULL,
	"attacker_player_id" uuid,
	"defender_player_id" uuid,
	"report" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"player_id" uuid NOT NULL,
	"player_name" text NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"region_id" text NOT NULL,
	"offer_resource" text NOT NULL,
	"offer_amount" double precision NOT NULL,
	"ask_resource" text NOT NULL,
	"ask_amount" double precision NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"filled_by_player_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"from_player_id" uuid,
	"to_player_id" uuid,
	"resource" text NOT NULL,
	"amount" double precision NOT NULL,
	"via" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alliance_invites" ADD CONSTRAINT "alliance_invites_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alliance_invites" ADD CONSTRAINT "alliance_invites_alliance_id_alliances_id_fk" FOREIGN KEY ("alliance_id") REFERENCES "public"."alliances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alliance_invites" ADD CONSTRAINT "alliance_invites_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alliance_members" ADD CONSTRAINT "alliance_members_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alliance_members" ADD CONSTRAINT "alliance_members_alliance_id_alliances_id_fk" FOREIGN KEY ("alliance_id") REFERENCES "public"."alliances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alliance_members" ADD CONSTRAINT "alliance_members_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alliances" ADD CONSTRAINT "alliances_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "armies" ADD CONSTRAINT "armies_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "armies" ADD CONSTRAINT "armies_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alliance_invites_unique_idx" ON "alliance_invites" USING btree ("alliance_id","player_id");--> statement-breakpoint
CREATE INDEX "alliance_members_alliance_idx" ON "alliance_members" USING btree ("alliance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alliances_match_tag_idx" ON "alliances" USING btree ("match_id","tag");--> statement-breakpoint
CREATE INDEX "armies_match_status_idx" ON "armies" USING btree ("match_id","status");--> statement-breakpoint
CREATE INDEX "armies_target_idx" ON "armies" USING btree ("match_id","target_region_id");--> statement-breakpoint
CREATE INDEX "battles_match_idx" ON "battles" USING btree ("match_id","resolved_at");--> statement-breakpoint
CREATE INDEX "chat_channel_idx" ON "chat_messages" USING btree ("match_id","channel","sent_at");--> statement-breakpoint
CREATE INDEX "market_orders_match_idx" ON "market_orders" USING btree ("match_id","status");--> statement-breakpoint
CREATE INDEX "transfers_match_idx" ON "transfers" USING btree ("match_id","at");