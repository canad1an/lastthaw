import { eq, like } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { matches } from "../db/schema.js";

/** "2026-10-ashen-ice": the month the match starts and its name, URL-safe. */
export function slugBase(name: string, startsAt: Date): string {
  const ym = startsAt.toISOString().slice(0, 7);
  const words = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${ym}-${words || "match"}`;
}

/** A slug nobody else has: the base, or the base with -2, -3 ... appended. */
export async function uniqueSlug(db: Db, name: string, startsAt: Date): Promise<string> {
  const base = slugBase(name, startsAt);
  const taken = new Set((await db.select({ slug: matches.slug }).from(matches).where(like(matches.slug, `${base}%`))).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now().toString(36)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^\d{4}-\d{2}-[a-z0-9-]{1,80}$/;
const cache = new Map<string, string>();

/** A match id from either its UUID or its slug (slugs never change, so they are cached). "bad" for something that is neither. */
export async function resolveMatchRef(db: Db, ref: string): Promise<string | null | "bad"> {
  if (UUID.test(ref)) return ref;
  if (!SLUG.test(ref)) return "bad";
  const hit = cache.get(ref);
  if (hit) return hit;
  const [m] = await db.select({ id: matches.id }).from(matches).where(eq(matches.slug, ref)).limit(1);
  if (!m) return null;
  cache.set(ref, m.id);
  return m.id;
}
