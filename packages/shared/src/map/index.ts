import worldJson from "./world.json" with { type: "json" };
import type { MapRegion, WorldMap } from "./types.js";

export * from "./types.js";

export const world: WorldMap = worldJson as WorldMap;

const byId: ReadonlyMap<string, MapRegion> = new Map(
  world.regions.map((r) => [r.id, r] as const),
);

export function allRegions(): readonly MapRegion[] {
  return world.regions;
}

export function regionById(id: string): MapRegion | undefined {
  return byId.get(id);
}

export interface RegionLink {
  id: string;
  region: MapRegion;
  via: "land" | "sea";
}

/** Land and sea neighbours of a region. Throws on an unknown id. */
export function neighborsOf(id: string): RegionLink[] {
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
  const r = byId.get(x);
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

/**
 * Throws if the world is structurally invalid: duplicate ids, unknown
 * neighbour ids, asymmetric adjacency, isolated regions, or regions with
 * no resources.
 */
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
export * from "./svgPath.js";
