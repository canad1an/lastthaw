-- Advisors' lists of regions to leave alone keep only regions the player still holds: a region lost (taken or
-- rebelled) lingered in the list, counted in the panel but never shown.
UPDATE "advisors" a
SET "settings" = jsonb_set(a."settings", '{skipRegions}', coalesce((
  SELECT jsonb_agg(s.id)
  FROM jsonb_array_elements_text(a."settings"->'skipRegions') AS s(id)
  WHERE EXISTS (
    SELECT 1 FROM "match_regions" r
    WHERE r."match_id" = a."match_id" AND r."region_id" = s.id AND r."owner_player_id" = a."player_id"
  )
), '[]'::jsonb))
WHERE jsonb_typeof(a."settings"->'skipRegions') = 'array' AND jsonb_array_length(a."settings"->'skipRegions') > 0;
