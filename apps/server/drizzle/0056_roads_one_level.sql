-- Roads has one level again: track is no longer Roads level 2 but every road of a player who knows Railways.
-- Roads at level 2 become level 1 (their owners' track comes back with Railways); sightings likewise.
UPDATE "match_regions"
SET "buildings" = jsonb_set("buildings", '{roads}', '1')
WHERE coalesce(("buildings"->>'roads')::numeric, 0) > 1;
--> statement-breakpoint
UPDATE "region_sightings"
SET "snapshot" = jsonb_set("snapshot", '{buildings,roads}', '1')
WHERE coalesce(("snapshot"->'buildings'->>'roads')::numeric, 0) > 1;
--> statement-breakpoint
-- The Economic advisor's minimum on Roads tops out at 1. (Queued level 2 builds are cancelled and refunded by the worker.)
UPDATE "advisors"
SET "settings" = jsonb_set("settings", '{minLevels,roads}', '1')
WHERE coalesce(("settings"->'minLevels'->>'roads')::numeric, 0) > 1;
