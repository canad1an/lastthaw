import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { DEFAULT_MAP, MAP_IDS, type MapId } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matches, players } from "../db/schema.js";


export const PAST_PAGE_SIZE = 20;

export interface PastSearch {
  q?: string;
  map?: MapId;
  kind?: "tournament" | "public";
  page: number;
  limit: number;
}

/** The archive's search parameters from a query string, cleaned: a name, a map, a kind, a page. */
export function pastSearchOf(query: Record<string, unknown>): PastSearch {
  const out: PastSearch = { page: 1, limit: PAST_PAGE_SIZE };
  if (typeof query.q === "string" && query.q.trim()) out.q = query.q.trim().slice(0, 60);
  if (typeof query.map === "string" && (MAP_IDS as readonly string[]).includes(query.map)) out.map = query.map as MapId;
  if (query.kind === "tournament" || query.kind === "public") out.kind = query.kind;
  const page = Number(query.page);
  if (Number.isInteger(page) && page > 1) out.page = Math.min(page, 10_000);
  const limit = Number(query.limit);
  if (Number.isInteger(limit) && limit >= 1 && limit <= PAST_PAGE_SIZE) out.limit = limit;
  return out;
}

export interface PastMatchView {
  id: string;
  slug: string;
  name: string;
  speed: number;
  startsAt: string;
  finishedAt: string | null;
  winnerName: string | null;
  winKind: string | null;
  kind: "tournament" | "public";
  map: MapId;
  humans: number;
  players: number;
}

/** Finished public matches matching the search, newest first, with the page count. */
export async function pastMatches(db: Db, s: PastSearch): Promise<{ matches: PastMatchView[]; total: number; page: number; pages: number }> {
  // Every finished match, private games included: once over, a game's report is public.
  const conditions = [eq(matches.status, "finished")];
  if (s.q) {
    const needle = `%${s.q.replace(/[%_\\\\]/g, (c) => `\\\\${c}`)}%`;
    // By the match's name, or by the name of anyone who played in it.
    conditions.push(sql`(${matches.name} ilike ${needle} or exists (select 1 from ${players} p where p.match_id = ${matches.id} and p.name ilike ${needle}))`);
  }
  if (s.map) conditions.push(s.map === DEFAULT_MAP ? sql`coalesce(${matches.settings}->>'map', 'earth') = 'earth'` : sql`${matches.settings}->>'map' = ${s.map}`);
  if (s.kind === "tournament") conditions.push(sql`(${matches.settings}->>'kind' = 'tournament' or (${matches.settings}->>'weekly')::boolean is true)`);
  if (s.kind === "public") conditions.push(sql`coalesce(${matches.settings}->>'kind', 'public') = 'public' and (${matches.settings}->>'weekly')::boolean is not true`);
  const where = and(...conditions);
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(matches).where(where);
  const total = count?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / s.limit));
  const page = Math.min(s.page, pages);
  const rows = await db.select().from(matches).where(where).orderBy(desc(matches.finishedAt)).limit(s.limit).offset((page - 1) * s.limit);
  const ids = rows.map((r) => r.id);
  const winnerIds = rows.map((r) => r.winnerPlayerId).filter((x): x is string => !!x);
  const winners = winnerIds.length ? await db.select({ id: players.id, name: players.name }).from(players).where(inArray(players.id, winnerIds)) : [];
  const counts = ids.length
    ? await db
        .select({ matchId: players.matchId, humans: sql<number>`count(*) filter (where not is_ai)::int`, total: sql<number>`count(*) filter (where not hidden)::int` })
        .from(players)
        .where(inArray(players.matchId, ids))
        .groupBy(players.matchId)
    : [];
  const countBy = new Map(counts.map((c) => [c.matchId, c]));
  const winnerBy = new Map(winners.map((w) => [w.id, w.name]));
  return {
    matches: rows.map((m) => {
      const settings = (m.settings ?? {}) as { kind?: string; weekly?: boolean; map?: string };
      const map = (MAP_IDS as readonly string[]).includes(settings.map ?? "") ? (settings.map as MapId) : DEFAULT_MAP;
      return {
        id: m.id,
        slug: m.slug ?? m.id,
        name: m.name,
        speed: m.speed,
        startsAt: m.startsAt.toISOString(),
        finishedAt: m.finishedAt?.toISOString() ?? null,
        winnerName: m.winnerPlayerId ? (winnerBy.get(m.winnerPlayerId) ?? null) : null,
        winKind: m.winKind ?? null,
        kind: settings.kind === "tournament" || settings.weekly ? "tournament" : "public",
        map,
        humans: countBy.get(m.id)?.humans ?? 0,
        players: countBy.get(m.id)?.total ?? 0,
      };
    }),
    total,
    page,
    pages,
  };
}
