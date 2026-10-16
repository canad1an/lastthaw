ALTER TABLE "user_match_results" ADD COLUMN "ranked" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Scheduled matches become tournaments; everything else is a public game. Tournament results are the ranked ones.
UPDATE "matches" SET "settings" = "settings" || '{"kind":"tournament"}'::jsonb WHERE "settings"->>'weekly' = 'true' AND "settings"->>'kind' IS NULL;--> statement-breakpoint
UPDATE "matches" SET "settings" = "settings" || '{"kind":"public"}'::jsonb WHERE "settings"->>'kind' IS NULL;--> statement-breakpoint
UPDATE "user_match_results" r SET "ranked" = true FROM "matches" m WHERE m.id = r.match_id AND m."settings"->>'kind' = 'tournament';
