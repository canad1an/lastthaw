ALTER TABLE "matches" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "matches_slug_idx" ON "matches" USING btree ("slug");
--> statement-breakpoint
with b as (
  select id,
         to_char(starts_at at time zone 'UTC', 'YYYY-MM') || '-' || coalesce(nullif(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''), 'match') as base,
         row_number() over (partition by to_char(starts_at at time zone 'UTC', 'YYYY-MM') || '-' || coalesce(nullif(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), ''), 'match') order by created_at) as n
  from matches where slug is null
)
update matches m set slug = b.base || case when b.n = 1 then '' else '-' || b.n end from b where m.id = b.id;
