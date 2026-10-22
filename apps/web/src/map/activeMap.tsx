import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_MAP, isMapLoaded, registerWorld, setMapResolver, type MapId, type WorldMap } from "@lastthaw/shared";
import earthCoast from "./earth/coastPoints.json";
import earthLanes from "./earth/lanePaths.json";

/** The per-map drawing data the map needs besides the regions: harbour points on the shore, water paths for lanes, and relief tiles. */
export interface MapAssets {
  coast: Record<string, { x: number; y: number; a: number } | undefined>;
  lanes: Record<string, { from: string; points: Array<[number, number]> } | undefined>;
  /** Folder under /map/<id>/relief with relief-4000.webp and relief-8000 tiles, or null when the map has no relief. */
  relief: string | null;
}

const assets: Partial<Record<MapId, MapAssets>> = {
  earth: { coast: earthCoast as MapAssets["coast"], lanes: earthLanes as unknown as MapAssets["lanes"], relief: "/map/earth/relief" },
};

/** Loaders for the maps that are not in the main bundle: fetched once, the first time a match on them opens. */
const loaders: Partial<Record<MapId, () => Promise<{ world: WorldMap; assets: MapAssets }>>> = {
  pangaea: () => fetchMap("pangaea", false),
};

/** A map published under /map/<id>/: world.json, coastPoints.json and lanePaths.json, plus relief tiles when it has them. */
async function fetchMap(id: MapId, relief: boolean): Promise<{ world: WorldMap; assets: MapAssets }> {
  const get = async <T,>(name: string): Promise<T> => {
    const res = await fetch(`/map/${id}/${name}`);
    if (!res.ok) throw new Error(`map ${id}: ${name} ${res.status}`);
    return (await res.json()) as T;
  };
  const [world, coast, lanes] = await Promise.all([get<WorldMap>("world.json"), get<MapAssets["coast"]>("coastPoints.json"), get<MapAssets["lanes"]>("lanePaths.json")]);
  return { world, assets: { coast, lanes, relief: relief ? `/map/${id}/relief` : null } };
}

let current: MapId = DEFAULT_MAP;
setMapResolver(() => current);

/** The map on screen; Earth outside a match. */
export function activeMap(): MapId {
  return current;
}

export function mapAssets(): MapAssets {
  return assets[current] ?? assets.earth!;
}

/** Fetches a map's data if it is not loaded yet. */
export async function ensureMap(id: MapId): Promise<void> {
  if (isMapLoaded(id) && assets[id]) return;
  const load = loaders[id];
  if (!load) throw new Error(`no loader for map ${id}`);
  const { world, assets: a } = await load();
  registerWorld(id, world);
  assets[id] = a;
}

/**
 * Puts a map in scope for everything rendered inside, loading it first if needed, and returns to Earth on unmount
 * (the home page and the lobby draw Earth).
 */
export function MapScope({ map, children, fallback = null }: { map: MapId; children: ReactNode; fallback?: ReactNode }) {
  const [ready, setReady] = useState(isMapLoaded(map) && !!assets[map]);
  useEffect(() => {
    let live = true;
    if (isMapLoaded(map) && assets[map]) setReady(true);
    else {
      setReady(false);
      void ensureMap(map).then(() => live && setReady(true));
    }
    return () => {
      live = false;
    };
  }, [map]);
  useEffect(() => () => {
    current = DEFAULT_MAP;
  }, []);
  if (!ready) return <>{fallback}</>;
  current = map;
  return <>{children}</>;
}
