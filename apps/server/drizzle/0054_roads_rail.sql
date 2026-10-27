-- Railway is no longer a building of its own: it is Roads level 2.
-- Regions with a Railway get Roads 2 and lose the railway key; sightings of them likewise.
UPDATE "match_regions"
SET "buildings" = ("buildings" - 'railway') || jsonb_build_object('roads', 2)
WHERE coalesce(("buildings"->>'railway')::numeric, 0) >= 1;
--> statement-breakpoint
UPDATE "match_regions"
SET "buildings" = "buildings" - 'railway'
WHERE "buildings" ? 'railway';
--> statement-breakpoint
UPDATE "region_sightings"
SET "snapshot" = jsonb_set("snapshot", '{buildings}', (("snapshot"->'buildings') - 'railway') || jsonb_build_object('roads', 2))
WHERE coalesce(("snapshot"->'buildings'->>'railway')::numeric, 0) >= 1;
--> statement-breakpoint
-- A Railway still queued becomes Roads level 2.
UPDATE "jobs"
SET "ref_id" = 'roads', "level" = 2
WHERE "kind" = 'build' AND "ref_id" = 'railway' AND "completed_at" IS NULL AND "cancelled_at" IS NULL;
--> statement-breakpoint
-- The Economic advisor's minimum for Railway becomes a minimum of 2 on Roads.
UPDATE "advisors"
SET "settings" = jsonb_set("settings" #- '{minLevels,railway}', '{minLevels,roads}', to_jsonb(greatest(coalesce(("settings"->'minLevels'->>'roads')::int, 0), 2)))
WHERE coalesce(("settings"->'minLevels'->>'railway')::int, 0) >= 1;
--> statement-breakpoint
UPDATE "advisors"
SET "settings" = "settings" #- '{minLevels,railway}'
WHERE "settings"->'minLevels' ? 'railway';
