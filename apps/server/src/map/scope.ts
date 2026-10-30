import { AsyncLocalStorage } from "node:async_hooks";
import { eq } from "drizzle-orm";
import { DEFAULT_MAP, MAP_IDS, loadMap, setEconomyRulesResolver, setMapResolver, type MapId } from "@lastthaw/shared";
import { carryIntoTransactions, type Db } from "../db/client.js";
import { matches } from "../db/schema.js";

/** A database or a transaction: anything that can select. */
type DbLike = Pick<Db, "select">;

/**
 * Which map the shared helpers (regionById, findRoute, seaPath...) read, per match, and which economy rules the shared
 * economy (applyTechEffects) plays by. The worker handles several
 * matches at once across its loops, and the API several requests, so the choice rides on the async context: every
 * per-match unit of work enters its match's map first. Anything unscoped reads Earth.
 */
export interface MapScope {
  map: MapId;
  /** Economy rules (settings.economy); absent reads 1. */
  economy?: number | undefined;
}

export const mapScope = new AsyncLocalStorage<MapScope>();
carryIntoTransactions(mapScope as AsyncLocalStorage<object>);

/** Puts every map in memory. Each entry point (API, worker, AI) awaits this before its first request or pass; a module-level await here would deadlock the bundle's lazy module init. */
export async function loadAllMaps(): Promise<void> {
  for (const id of MAP_IDS) await loadMap(id);
}
setMapResolver(() => mapScope.getStore()?.map ?? DEFAULT_MAP);
setEconomyRulesResolver(() => mapScope.getStore()?.economy ?? 1);

/** The map a match is played on, from its settings. */
export function mapOf(m: { settings: unknown }): MapId {
  const map = (m.settings as { map?: string } | null)?.map;
  return (MAP_IDS as readonly string[]).includes(map ?? "") ? (map as MapId) : DEFAULT_MAP;
}

/** The economy rules a match plays by, from its settings: 1 for every match made before rules 2. */
export function economyRulesOf(m: { settings: unknown }): number {
  const v = (m.settings as { economy?: unknown } | null)?.economy;
  return typeof v === "number" ? v : 1;
}

/** The scope of a match: its map and its economy rules. */
export function scopeOf(m: { settings: unknown }): MapScope {
  return { map: mapOf(m), economy: economyRulesOf(m) };
}

/**
 * Enters a match's map for the rest of the caller's async flow: the remainder of the calling function and everything it
 * awaits. Call it directly from the function that does the work (a context entered inside a callee after an await
 * does not reach the caller), with the scope looked up first: `enterMap(await scopeOfMatch(db, id))`. A bare map id
 * enters that map under rules 1.
 */
export function enterMap(scope: MapScope | MapId): void {
  const { map, economy } = typeof scope === "string" ? { map: scope, economy: undefined } : scope;
  const store = mapScope.getStore();
  if (store) {
    store.map = map;
    store.economy = economy;
  } else mapScope.enterWith({ map, economy });
}

/** Runs fn with the match's map in scope. */
export function withMap<T>(map: MapId, fn: () => Promise<T>): Promise<T> {
  return mapScope.run({ map }, fn);
}

// A match's map and rules never change once it is created, so one lookup per match per process is enough.
const byMatch = new Map<string, MapScope>();

/** The scope (map and economy rules) of a match by id, cached. */
export async function scopeOfMatch(db: DbLike, matchId: string): Promise<MapScope> {
  const hit = byMatch.get(matchId);
  if (hit) return { ...hit };
  const [m] = await db.select({ settings: matches.settings }).from(matches).where(eq(matches.id, matchId)).limit(1);
  const scope = m ? scopeOf(m) : { map: DEFAULT_MAP };
  if (m) byMatch.set(matchId, scope);
  return { ...scope };
}

/** The map of a match by id, cached. */
export async function mapOfMatch(db: DbLike, matchId: string): Promise<MapId> {
  return (await scopeOfMatch(db, matchId)).map;
}
