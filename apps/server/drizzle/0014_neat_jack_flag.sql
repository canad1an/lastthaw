ALTER TABLE "match_regions" ADD COLUMN "conquered" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "match_regions" SET "conquered" = true WHERE "pop_occupiers" > 0;