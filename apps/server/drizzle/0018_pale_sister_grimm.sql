ALTER TYPE "public"."mission_kind" ADD VALUE 'patrol';--> statement-breakpoint
ALTER TABLE "armies" ADD COLUMN "lane" text;