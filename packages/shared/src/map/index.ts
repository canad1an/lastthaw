import earthJson from "./world.json" with { type: "json" };
import type { MapRegion, WorldMap } from "./types.js";

export * from "./types.js";

/** The maps a match can be played on. Earth is the default; others are registered when their data is loaded. */
export const MAP_IDS = ["earth", "pangaea"] as const;
export type MapId = (typeof MAP_IDS)[number];
export const MAP_NAMES: Record<MapId, string> = { earth: "Earth", pangaea: "Pangaea" };
export const MAP_BLURBS: Record<MapId, string> = {
  earth: "The real world, today's coastlines, about 400 provinces.",
  pangaea: "The supercontinent of 250 million years ago: one landmass, nearly everything reachable by land.",
};
export const DEFAULT_MAP: MapId = "earth";

interface MapData {
  id: MapId;
  world: WorldMap;
  byId: ReadonlyMap<string, MapRegion>;
}

const registry = new Map<MapId, MapData>();

/** Makes a map's data available to the helpers below. Earth is registered at load; other maps when their JSON arrives. */
export function registerWorld(id: MapId, w: WorldMap): void {
  registry.set(id, { id, world: w, byId: new Map(w.regions.map((r) => [r.id, r] as const)) });
}
registerWorld("earth", earthJson as WorldMap);

export function isMapLoaded(id: MapId): boolean {
  return registry.has(id);
}

/**
 * Loads a map that is not bundled with the module. The server loads every map at startup; the web app fetches a map's
 * published files instead (see apps/web/src/map/activeMap.tsx), so the JSON stays out of its bundle.
 */
export async function loadMap(id: MapId): Promise<void> {
  if (registry.has(id)) return;
  if (id === "pangaea") {
    const m = await import("./pangaea.json", { with: { type: "json" } });
    registerWorld("pangaea", m.default as WorldMap);
  }
}

/** Earth's map, for code that is about Earth whatever match is in play (the home page, generators, tests). */
export const earth: WorldMap = earthJson as WorldMap;

/**
 * Which map the helpers read: the server installs a resolver that answers per match (one request or worker pass at a
 * time), the web one that answers for the match on screen. Unscoped code gets Earth.
 */
let resolver: () => MapId = () => DEFAULT_MAP;
export function setMapResolver(fn: () => MapId): void {
  resolver = fn;
}
export function activeMapId(): MapId {
  return resolver();
}

function data(): MapData {
  const id = resolver();
  const d = registry.get(id);
  if (!d) throw new Error(`map ${id} is not loaded`);
  return d;
}

/** The map in play. */
export function activeWorld(): WorldMap {
  return data().world;
}

export function allRegions(): readonly MapRegion[] {
  return data().world.regions;
}

export function regionById(id: string): MapRegion | undefined {
  return data().byId.get(id);
}

export interface RegionLink {
  id: string;
  region: MapRegion;
  via: "land" | "sea";
}

/** Land and sea neighbours of a region. Throws on an unknown id. */
export function neighborsOf(id: string): RegionLink[] {
  const byId = data().byId;
  const region = byId.get(id);
  if (!region) throw new Error(`Unknown region: ${id}`);
  const out: RegionLink[] = [];
  for (const n of region.neighbors) {
    const r = byId.get(n);
    if (r) out.push({ id: n, region: r, via: "land" });
  }
  for (const n of region.seaRoutes) {
    const r = byId.get(n);
    if (r) out.push({ id: n, region: r, via: "sea" });
  }
  return out;
}

const EARTH_RADIUS_KM = 6371;

function toRegion(x: string | MapRegion): MapRegion {
  if (typeof x !== "string") return x;
  const r = data().byId.get(x);
  if (!r) throw new Error(`Unknown region: ${x}`);
  return r;
}

/** Great-circle distance in km between two region centroids (haversine). */
export function distanceKm(a: string | MapRegion, b: string | MapRegion): number {
  const ra = toRegion(a);
  const rb = toRegion(b);
  const toRad = Math.PI / 180;
  const dLat = (rb.lat - ra.lat) * toRad;
  const dLon = (rb.lon - ra.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(ra.lat * toRad) * Math.cos(rb.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function validateWorld(w: WorldMap): void {
  const ids = new Set<string>();
  const index = new Map<string, MapRegion>();
  for (const r of w.regions) {
    if (ids.has(r.id)) throw new Error(`Duplicate region id: ${r.id}`);
    ids.add(r.id);
    index.set(r.id, r);
  }
  for (const r of w.regions) {
    if (r.neighbors.length + r.seaRoutes.length === 0) {
      throw new Error(`Region ${r.id} has no neighbours`);
    }
    if (r.resources.length === 0) throw new Error(`Region ${r.id} has no resources`);
    for (const kind of ["neighbors", "seaRoutes"] as const) {
      for (const n of r[kind]) {
        const other = index.get(n);
        if (!other) throw new Error(`Region ${r.id} has unknown ${kind} id ${n}`);
        if (!other[kind].includes(r.id)) {
          throw new Error(`Asymmetric ${kind}: ${r.id} -> ${n} but not back`);
        }
      }
    }
  }
}
