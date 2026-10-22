import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { DEFAULT_MAP, MAP_IDS, loadMap, setMapResolver, type MapId } from "@lastthaw/shared";
import { carryIntoTransactions, type Db } from "../db/client.js";
import { matches } from "../db/schema.js";

/** A database or a transaction: anything that can select. */
type DbLike = Pick<Db, "select">;

/**
 * Which map the shared helpers (regionById, findRoute, seaPath...) read, per match. The worker handles several
 * matches at once across its loops, and the API several requests, so the choice rides on the async context: every
 * per-match unit of work enters its match's map first. Anything unscoped reads Earth.
 */
export interface MapScope {
  map: MapId;
}

export const mapScope = new AsyncLocalStorage<MapScope>();
carryIntoTransactions(mapScope as AsyncLocalStorage<object>);

/** Puts every map in memory. Each entry point (API, worker, AI) awaits this before its first request or pass; a module-level await here would deadlock the bundle's lazy module init. */
export async function loadAllMaps(): Promise<void> {
  for (const id of MAP_IDS) await loadMap(id);
}
setMapResolver(() => mapScope.getStore()?.map ?? DEFAULT_MAP);

/** The map a match is played on, from its settings. */
export function mapOf(m: { settings: unknown }): MapId {
  const map = (m.settings as { map?: string } | null)?.map;
  return (MAP_IDS as readonly string[]).includes(map ?? "") ? (map as MapId) : DEFAULT_MAP;
}

/**
 * Enters a match's map for the rest of the caller's async flow: the remainder of the calling function and everything it
 * awaits. Call it directly from the function that does the work (a context entered inside a callee after an await
 * does not reach the caller), with the map looked up first: `enterMap(await mapOfMatch(db, id))`.
 */
export function enterMap(map: MapId): void {
  const store = mapScope.getStore();
  if (store) store.map = map;
  else mapScope.enterWith({ map });
}

/** Runs fn with the match's map in scope. */
export function withMap<T>(map: MapId, fn: () => Promise<T>): Promise<T> {
  return mapScope.run({ map }, fn);
}

// A match's map never changes once it is created, so one lookup per match per process is enough.
const byMatch = new Map<string, MapId>();

/** The map of a match by id, cached. */
export async function mapOfMatch(db: DbLike, matchId: string): Promise<MapId> {
  const hit = byMatch.get(matchId);
  if (hit) return hit;
  const [m] = await db.select({ settings: matches.settings }).from(matches).where(eq(matches.id, matchId)).limit(1);
  const map = m ? mapOf(m) : DEFAULT_MAP;
  if (m) byMatch.set(matchId, map);
  return map;
}
