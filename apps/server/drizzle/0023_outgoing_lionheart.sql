ALTER TABLE "users" ADD COLUMN "approved_at" timestamp with time zone;
--> statement-breakpoint
-- Everyone who had an account before the private beta gate keeps their access.
UPDATE "users" SET "approved_at" = now() WHERE "approved_at" IS NULL;
