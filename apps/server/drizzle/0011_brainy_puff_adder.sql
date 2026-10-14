ALTER TABLE "match_regions" ADD COLUMN "is_capital" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "match_regions" r SET "is_capital" = true FROM "players" p WHERE p."match_id" = r."match_id" AND p."capital_region_id" = r."region_id";