/**
 * Last Thaw world map generator.
 *
 * Natural Earth admin-1 provinces -> ~400 regions of roughly equal "value"
 * (area x latitude factor x desert factor), merged within each country,
 * with terrain, resources, land adjacency, sea routes and SVG paths.
 *
 * Usage: npm run generate --workspace=@lastthaw/mapgen
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as d3 from "d3-geo";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { merge as topoMerge, neighbors as topoNeighbors, quantize as topoQuantize } from "topojson-client";
import { topology as buildTopology } from "topojson-server";
import { presimplify } from "topojson-simplify";
import type {
  GeometryCollection,
  GeometryObject,
  MultiPolygon as TopoMultiPolygon,
  Polygon as TopoPolygon,
  Topology,
} from "topojson-specification";
import type { MapRegion, ResourceKind, Terrain, WorldMap } from "../../../packages/shared/src/map/types.js";
import { rngFor } from "./rng.js";

// ---------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_DIR = path.join(ROOT, "config");
const OUT_DIR = path.join(ROOT, "out");
const SHARED_MAP_DIR = path.resolve(ROOT, "..", "..", "packages", "shared", "src", "map");
const WORLD_JSON = path.join(SHARED_MAP_DIR, "world.json");

const SEED = "lastthaw-1";
const TARGET_REGIONS = 400;
const COUNT_MIN = 380;
const COUNT_MAX = 420;
const WIDTH = 2000;
const HEIGHT = 1000;
const EARTH_RADIUS_KM = 6371;
const R2 = EARTH_RADIUS_KM * EARTH_RADIUS_KM;

/** Islands smaller than this with no land neighbour are dropped outright. */
const MIN_ISLAND_KM2 = 2000;
/** Countries below 0.25% of total value are merged into a neighbour... */
const COUNTRY_VALUE_SHARE = 0.0025;
/** ...unless they are at least this big (keeps Switzerland, Ireland, Cuba, Sri Lanka). */
const MIN_COUNTRY_AREA_KM2 = 25_000;
/** A province with no same-country neighbour within this distance is detached. */
const SAME_COUNTRY_REACH_KM = 1500;
/** Detached provinces at least this big stay as their own region (Alaska, Hawaii, Svalbard). */
const STANDALONE_KM2 = 20_000;
/** Orphan provinces may be absorbed by a foreign region at most this far away. */
const ORPHAN_REACH_KM = 1500;
const SEA_ROUTE_MAX_KM = 2500;
const SEA_ROUTE_COUNT = 2;
/** Regions worth less than this fraction of the mean are always merged. */
const MIN_REGION_VALUE_FRACTION = 0.25;
/** Budget for the sum of all SVG path strings, in bytes. */
const PATH_BUDGET_BYTES = 700_000;
/** Coastlines of regions whose path exceeds this are simplified harder. */
const PATH_CAP_BYTES = 4500;
/** Countries whose NE parent "region" is a macro-region, not a usable name. */
const NO_PARENT_REGION_NAMES = new Set(["cn", "ru", "in", "us", "ca", "au", "br", "mx", "kz", "ar"]);

const SOURCES = [
  "ne_10m_admin_1_states_provinces",
  "ne_50m_admin_1_states_provinces_lakes",
  "ne_50m_admin_1_states_provinces",
] as const;
const SOURCE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/";

// ---------------------------------------------------------------------------
// Config file shapes
// ---------------------------------------------------------------------------

interface DesertBox {
  name: string;
  lonMin: number;
  latMin: number;
  lonMax: number;
  latMax: number;
}

interface Override {
  match: { id?: string; country?: string; name?: string };
  terrain?: Terrain;
  name?: string;
  river?: boolean;
  resources?: ResourceKind[];
  note?: string;
}

interface SeaRouteEntry {
  a: string;
  b: string;
  note?: string;
}

function readConfig<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(CONFIG_DIR, file), "utf8")) as T;
}

// ---------------------------------------------------------------------------
// Small geo helpers
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

type Vec3 = [number, number, number];

function toVec(lat: number, lon: number, w: number): Vec3 {
  const cl = Math.cos(lat * DEG);
  return [w * cl * Math.cos(lon * DEG), w * cl * Math.sin(lon * DEG), w * Math.sin(lat * DEG)];
}

function fromVec(v: Vec3): { lat: number; lon: number } {
  const [x, y, z] = v;
  const lon = Math.atan2(y, x) / DEG;
  const lat = Math.atan2(z, Math.hypot(x, y)) / DEG;
  return { lat, lon };
}

function addVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function latitudeFactor(absLat: number): number {
  if (absLat < 50) return 1;
  if (absLat < 60) return 0.6;
  if (absLat < 70) return 0.25;
  return 0.05;
}

function inDesert(boxes: DesertBox[], lat: number, lon: number): boolean {
  return boxes.some((b) => lon >= b.lonMin && lon <= b.lonMax && lat >= b.latMin && lat <= b.latMax);
}

const LETTER_MAP: Record<string, string> = {
  "\u00f8": "o", "\u00e6": "ae", "\u00df": "ss", "\u0142": "l", "\u0111": "d", "\u00f0": "d", "\u00fe": "th", "\u0153": "oe",
};

function ascii(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u00f8\u00e6\u00df\u0142\u0111\u00f0\u00fe\u0153]/g, (ch) => LETTER_MAP[ch] ?? ch)
    .replace(/[\u0027\u0060\u2018\u2019\u02bb\u02bf\u02be]/g, "");
}

function slugify(s: string): string {
  return ascii(s)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function norm(s: string): string {
  return ascii(s);
}
// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

type ProvFeature = Feature<Polygon | MultiPolygon, Record<string, unknown>>;

async function loadProvinces(): Promise<FeatureCollection<Polygon | MultiPolygon, Record<string, unknown>>> {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const name of SOURCES) {
    const file = path.join(DATA_DIR, `${name}.geojson`);
    if (!existsSync(file)) {
      const url = `${SOURCE_BASE}${name}.geojson`;
      console.log(`Downloading ${url}`);
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`  -> HTTP ${res.status}, trying next source`);
        continue;
      }
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    console.log(`Using ${file}`);
    return JSON.parse(readFileSync(file, "utf8"));
  }
  throw new Error("No Natural Earth admin-1 source could be downloaded");
}

// ---------------------------------------------------------------------------
// Provinces
// ---------------------------------------------------------------------------

interface Prov {
  i: number;
  name: string;
  nameEn: string;
  /** NE parent region (e.g. "Nouvelle-Aquitaine"), if any. */
  parentRegion: string;
  /** NE unit type (State, Province, Department...). */
  typeEn: string;
  /** Original adm0_a3 country key. */
  a3: string;
  /** Current (possibly host) country key. */
  country: string;
  areaKm2: number;
  lat: number;
  lon: number;
  value: number;
  arcs: number[];
  coastal: boolean;
  nb: number[];
  dropped: boolean;
}

interface Country {
  a3: string;
  iso2: string;
  name: string;
  provs: number[];
  value: number;
  areaKm2: number;
}

function flattenArcs(g: GeometryObject): number[] {
  const out: number[] = [];
  const walk = (a: unknown): void => {
    if (Array.isArray(a)) {
      for (const x of a) walk(x);
    } else if (typeof a === "number") {
      out.push(a < 0 ? ~a : a);
    }
  };
  if (g.type === "Polygon" || g.type === "MultiPolygon") walk(g.arcs);
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" && v.length > 0 ? v : "";
}

// ---------------------------------------------------------------------------
// Merge work units
// ---------------------------------------------------------------------------

interface Work {
  members: number[];
  value: number;
  areaKm2: number;
  country: string;
  fixed: boolean;
  vec: Vec3;
}

function workOf(p: Prov): Work {
  return {
    members: [p.i],
    value: p.value,
    areaKm2: p.areaKm2,
    country: p.country,
    fixed: false,
    vec: toVec(p.lat, p.lon, p.areaKm2),
  };
}

function centroidOf(w: Work): { lat: number; lon: number } {
  return fromVec(w.vec);
}

function absorb(host: Work, w: Work): void {
  host.members.push(...w.members);
  host.value += w.value;
  host.areaKm2 += w.areaKm2;
  host.vec = addVec(host.vec, w.vec);
}

function distWork(a: Work, b: Work): number {
  const ca = centroidOf(a);
  const cb = centroidOf(b);
  return haversineKm(ca.lat, ca.lon, cb.lat, cb.lon);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = Date.now();
  const desertBoxes = readConfig<DesertBox[]>("desert-boxes.json");
  const overrides = readConfig<Override[]>("overrides.json");
  const seaRouteEntries = readConfig<SeaRouteEntry[]>("sea-routes.json");

  const raw = await loadProvinces();
  const features = raw.features.filter(
    (f): f is ProvFeature =>
      !!f.geometry &&
      (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") &&
      f.properties?.["admin"] !== "Antarctica",
  );
  console.log(`${features.length} provinces (Antarctica dropped)`);

  // Topology: shared borders become shared arcs. Quantize so borders snap.
  const topo = buildTopology({ p: { type: "FeatureCollection", features } as FeatureCollection }, 1e5) as Topology<{
    p: GeometryCollection;
  }>;
  // presimplify de-quantizes to absolute lon/lat and attaches a weight per point.
  const ps = presimplify(topo);
  const geoms = ps.objects.p.geometries;
  const nbList = topoNeighbors(geoms);

  // Arc lengths (km) and owners.
  const arcLen = ps.arcs.map((arc) => {
    let len = 0;
    for (let i = 1; i < arc.length; i++) {
      const a = arc[i - 1]!;
      const b = arc[i]!;
      len += haversineKm(a[1]!, a[0]!, b[1]!, b[0]!);
    }
    return len;
  });
  const arcOwners: number[][] = ps.arcs.map(() => []);

  const provs: Prov[] = features.map((f, i) => {
    const p = f.properties;
    const a3 = str(p["adm0_a3"]) || "UNK";
    const name = str(p["name"]) || str(p["name_en"]) || str(p["gn_name"]) || `${str(p["admin"])} ${i}`;
    const areaKm2 = d3.geoArea(f) * R2;
    const [lon, lat] = d3.geoCentroid(f);
    const arcs = [...new Set(flattenArcs(geoms[i]!))];
    for (const a of arcs) arcOwners[a]!.push(i);
    const desert = inDesert(desertBoxes, lat, lon) ? 0.5 : 1;
    return {
      i,
      name,
      nameEn: str(p["name_en"]) || name,
      parentRegion: str(p["region"]),
      typeEn: str(p["type_en"]),
      a3,
      country: a3,
      areaKm2,
      lat,
      lon,
      value: areaKm2 * latitudeFactor(Math.abs(lat)) * desert,
      arcs,
      coastal: false,
      nb: nbList[i]!,
      dropped: false,
    };
  });
  for (const p of provs) p.coastal = p.arcs.some((a) => arcOwners[a]!.length === 1);

  // Step 1: tiny isolated islands.
  let droppedIslands = 0;
  for (const p of provs) {
    if (p.nb.length === 0 && p.areaKm2 < MIN_ISLAND_KM2) {
      p.dropped = true;
      droppedIslands++;
    }
  }
  console.log(`dropped ${droppedIslands} isolated islands < ${MIN_ISLAND_KM2} km2`);

  // Countries.
  const countries = new Map<string, Country>();
  for (const f of features) {
    const p = f.properties;
    const a3 = str(p["adm0_a3"]) || "UNK";
    if (countries.has(a3)) continue;
    const isoA2 = str(p["iso_a2"]);
    const iso2 = /^[A-Za-z]{2}$/.test(isoA2) ? isoA2.toLowerCase() : a3.toLowerCase();
    countries.set(a3, { a3, iso2, name: str(p["admin"]) || a3, provs: [], value: 0, areaKm2: 0 });
  }
  for (const p of provs) {
    if (p.dropped) continue;
    const c = countries.get(p.a3)!;
    c.provs.push(p.i);
    c.value += p.value;
    c.areaKm2 += p.areaKm2;
  }
  const totalValue = [...countries.values()].reduce((s, c) => s + c.value, 0);
  const threshold = totalValue * COUNTRY_VALUE_SHARE;

  // Step 2: small countries merge into the neighbour with the largest shared border.
  const surviving = new Set<string>();
  for (const c of countries.values()) {
    if (c.provs.length === 0) continue;
    if (c.value >= threshold || c.areaKm2 >= MIN_COUNTRY_AREA_KM2) surviving.add(c.a3);
  }
  const small = [...countries.values()]
    .filter((c) => c.provs.length > 0 && !surviving.has(c.a3))
    .sort((a, b) => b.value - a.value);
  const survivingProvs = () => provs.filter((p) => !p.dropped && surviving.has(p.country));
  let droppedCountries: string[] = [];
  for (const c of small) {
    const border = new Map<string, number>();
    for (const pi of c.provs) {
      for (const a of provs[pi]!.arcs) {
        for (const o of arcOwners[a]!) {
          const op = provs[o]!;
          if (op.a3 === c.a3 || op.dropped || !surviving.has(op.country)) continue;
          border.set(op.country, (border.get(op.country) ?? 0) + arcLen[a]!);
        }
      }
    }
    let host: string | undefined;
    if (border.size > 0) {
      host = [...border.entries()].sort((x, y) => y[1] - x[1])[0]![0];
    } else {
      // Nearest surviving province by centroid.
      const cc = fromVec(
        c.provs.reduce((v, pi) => addVec(v, toVec(provs[pi]!.lat, provs[pi]!.lon, provs[pi]!.areaKm2)), [0, 0, 0] as Vec3),
      );
      let best = Infinity;
      for (const p of survivingProvs()) {
        const d = haversineKm(cc.lat, cc.lon, p.lat, p.lon);
        if (d < best) {
          best = d;
          host = p.country;
        }
      }
      if (best > ORPHAN_REACH_KM) host = undefined;
    }
    if (!host) {
      droppedCountries.push(c.name);
      for (const pi of c.provs) provs[pi]!.dropped = true;
      continue;
    }
    const h = countries.get(host)!;
    for (const pi of c.provs) {
      provs[pi]!.country = host;
      h.provs.push(pi);
    }
    h.value += c.value;
    h.areaKm2 += c.areaKm2;
    c.provs = [];
  }
  console.log(
    `${surviving.size} countries kept, ${small.length - droppedCountries.length} merged into neighbours, ` +
      `${droppedCountries.length} dropped (${droppedCountries.join(", ")})`,
  );

  const hostValueTotal = [...surviving].reduce((s, a3) => s + countries.get(a3)!.value, 0);

  // Step 3: within-country agglomeration, re-run with a scalar until the count lands in range.
  interface Pass {
    works: Work[];
    regionOf: Map<number, Work>;
    droppedOrphans: string[];
  }

  const minRegionValue = (MIN_REGION_VALUE_FRACTION * hostValueTotal) / TARGET_REGIONS;
  const isIsolated = (w: Work, regionOf: Map<number, Work>): boolean => {
    if (w.fixed) return false;
    const memberSet = new Set(w.members);
    for (const m of w.members) {
      for (const n of provs[m]!.nb) {
        if (memberSet.has(n)) continue;
        const o = regionOf.get(n);
        if (o && o !== w) return false;
      }
    }
    return true;
  };

  function runPass(scalar: number): Pass {
    const works: Work[] = [];
    const orphans: Work[] = [];
    for (const a3 of surviving) {
      const c = countries.get(a3)!;
      const target = Math.max(1, Math.round((scalar * TARGET_REGIONS * c.value) / hostValueTotal));
      const items: Work[] = c.provs.filter((pi) => !provs[pi]!.dropped).map((pi) => workOf(provs[pi]!));
      const regionOf = new Map<number, Work>();
      for (const w of items) regionOf.set(w.members[0]!, w);
      const remove = (w: Work) => items.splice(items.indexOf(w), 1);

      while (true) {
        const candidates = items.filter((w) => !w.fixed).sort((x, y) => x.value - y.value);
        const low = candidates[0];
        if (!low) break;
        if (items.length <= target && low.value >= minRegionValue && !isIsolated(low, regionOf)) break;
        const memberSet = new Set(low.members);
        const adjacent = new Set<Work>();
        for (const m of low.members) {
          for (const n of provs[m]!.nb) {
            if (memberSet.has(n)) continue;
            const w = regionOf.get(n);
            if (w && w !== low) adjacent.add(w);
          }
        }
        let host: Work | undefined;
        if (adjacent.size > 0) {
          host = [...adjacent].sort((x, y) => x.value - y.value)[0];
        } else {
          let best = SAME_COUNTRY_REACH_KM;
          for (const w of items) {
            if (w === low) continue;
            const d = distWork(low, w);
            if (d < best) {
              best = d;
              host = w;
            }
          }
        }
        if (host) {
          absorb(host, low);
          for (const m of low.members) regionOf.set(m, host);
          remove(low);
        } else if (low.areaKm2 >= STANDALONE_KM2) {
          low.fixed = true;
        } else {
          orphans.push(low);
          remove(low);
        }
      }
      works.push(...items);
    }

    // Orphans: join the adjacent region with the largest shared border, else nearest within reach.
    const regionOf = new Map<number, Work>();
    for (const w of works) for (const m of w.members) regionOf.set(m, w);
    const droppedOrphans: string[] = [];
    for (const o of orphans.sort((x, y) => y.value - x.value)) {
      const border = new Map<Work, number>();
      const memberSet = new Set(o.members);
      for (const m of o.members) {
        for (const a of provs[m]!.arcs) {
          for (const owner of arcOwners[a]!) {
            if (memberSet.has(owner)) continue;
            const w = regionOf.get(owner);
            if (w) border.set(w, (border.get(w) ?? 0) + arcLen[a]!);
          }
        }
      }
      let host: Work | undefined;
      if (border.size > 0) {
        host = [...border.entries()].sort((x, y) => y[1] - x[1])[0]![0];
      } else {
        let best = ORPHAN_REACH_KM;
        for (const w of works) {
          const d = distWork(o, w);
          if (d < best) {
            best = d;
            host = w;
          }
        }
      }
      if (host) {
        absorb(host, o);
        for (const m of o.members) regionOf.set(m, host);
      } else {
        droppedOrphans.push(o.members.map((m) => provs[m]!.name).join("+"));
      }
    }
    return { works, regionOf, droppedOrphans };
  }

  let scalar = 1;
  let pass = runPass(scalar);
  for (let iter = 0; iter < 12; iter++) {
    const n = pass.works.length;
    console.log(`pass ${iter}: scalar=${scalar.toFixed(3)} -> ${n} regions`);
    if (n >= COUNT_MIN && n <= COUNT_MAX) break;
    scalar *= TARGET_REGIONS / n;
    pass = runPass(scalar);
  }
  const { works, regionOf, droppedOrphans } = pass;
  if (droppedOrphans.length) console.log(`dropped orphan provinces: ${droppedOrphans.join(", ")}`);
  if (works.length < COUNT_MIN || works.length > COUNT_MAX) {
    throw new Error(`Region count ${works.length} outside ${COUNT_MIN}-${COUNT_MAX}`);
  }

  // Step 4: ids, names, centroids.
  const provsByA3 = new Map<string, number>();
  for (const p of provs) if (!p.dropped) provsByA3.set(p.a3, (provsByA3.get(p.a3) ?? 0) + 1);

  interface Draft {
    work: Work;
    id: string;
    name: string;
    country: Country;
    aliases: string[];
    lat: number;
    lon: number;
    terrain: Terrain;
    river: boolean;
    resources: ResourceKind[];
    coastal: boolean;
    land: Set<Draft>;
    sea: Set<Draft>;
  }

  const projection = d3
    .geoEquirectangular()
    .scale(WIDTH / (2 * Math.PI))
    .translate([WIDTH / 2, HEIGHT / 2])
    .precision(0);

  works.sort((a, b) => {
    const ca = countries.get(a.country)!.iso2;
    const cb = countries.get(b.country)!.iso2;
    return ca < cb ? -1 : ca > cb ? 1 : b.value - a.value;
  });

  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  const drafts: Draft[] = works.map((w) => {
    const country = countries.get(w.country)!;
    const members = w.members.map((m) => provs[m]!).sort((x, y) => y.value - x.value);
    const largest = members[0]!;
    let name = largest.name;
    if (
      members.length >= 3 &&
      largest.parentRegion &&
      largest.parentRegion !== largest.name &&
      !usedNames.has(`${country.iso2}:${largest.parentRegion}`) &&
      !NO_PARENT_REGION_NAMES.has(country.iso2) &&
      /department|district|county|borough|council|unitary|province|prefecture|comarca|municipality|canton/i.test(largest.typeEn)
    ) {
      name = largest.parentRegion;
    }
    // Whole country (ignoring absorbed micro-states): use the country name.
    if (members.filter((m) => m.a3 === largest.a3).length === provsByA3.get(largest.a3)) {
      name = countries.get(largest.a3)!.name;
    }
    usedNames.add(`${country.iso2}:${name}`);
    let base = `${country.iso2}-${slugify(name) || slugify(largest.nameEn) || "region"}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    const { lat, lon } = centroidOf(w);
    const aliases = [...new Set(members.flatMap((m) => [norm(m.name), norm(m.nameEn)]))];
    return {
      work: w,
      id,
      name,
      country,
      aliases,
      lat,
      lon,
      terrain: "plains",
      river: false,
      resources: [],
      coastal: members.some((m) => m.coastal),
      land: new Set(),
      sea: new Set(),
    };
  });
  const draftOf = new Map<Work, Draft>(drafts.map((d) => [d.work, d]));

  // Land adjacency.
  for (const d of drafts) {
    for (const m of d.work.members) {
      for (const n of provs[m]!.nb) {
        const w = regionOf.get(n);
        if (w && w !== d.work) d.land.add(draftOf.get(w)!);
      }
    }
  }

  // Step 5: terrain.
  const BANDS: Array<[number, Array<[Terrain, number]>]> = [
    [15, [["forest", 50], ["plains", 25], ["hills", 15], ["wetland", 10]]],
    [35, [["plains", 40], ["hills", 25], ["desert", 10], ["forest", 15], ["mountains", 10]]],
    [50, [["forest", 35], ["plains", 30], ["hills", 20], ["mountains", 15]]],
    [62, [["forest", 55], ["plains", 20], ["hills", 15], ["mountains", 10]]],
  ];
  for (const d of drafts) {
    const rng = rngFor(SEED, `${d.id}:terrain`);
    const absLat = Math.abs(d.lat);
    if (absLat > 62) d.terrain = "tundra";
    else if (inDesert(desertBoxes, d.lat, d.lon)) d.terrain = "desert";
    else {
      const band = BANDS.find(([max]) => absLat < max)![1];
      d.terrain = band[rng.weightedIndex(band.map(([, w]) => w))]![0];
    }
    d.river = rngFor(SEED, `${d.id}:river`).next() < 0.3;
  }

  // Overrides, pass 1 (terrain / name / river) so resource eligibility sees them.
  const matchOverride = (o: Override): Draft[] => {
    const m = o.match;
    return drafts.filter((d) => {
      if (m.id && d.id !== m.id) return false;
      if (m.country && d.country.iso2 !== m.country) return false;
      if (m.name) {
        const needle = norm(m.name);
        if (!d.id.includes(needle) && !d.aliases.some((a) => a.includes(needle))) return false;
      }
      return true;
    });
  };
  const unmatched: string[] = [];
  const overrideHits = overrides.map((o) => {
    const hits = matchOverride(o);
    if (hits.length === 0) unmatched.push(JSON.stringify(o.match));
    for (const d of hits) {
      if (o.terrain) d.terrain = o.terrain;
      if (o.name) d.name = o.name;
      if (o.river !== undefined) d.river = o.river;
    }
    return hits;
  });

  // Step 6: resources.
  const RESOURCES: Array<[ResourceKind, number, (d: Draft) => boolean]> = [
    ["fertile_soil", 18, () => true],
    ["timber", 14, () => true],
    ["flint", 10, () => true],
    ["fish", 10, (d) => d.coastal || d.river],
    ["copper", 8, () => true],
    ["tin", 5, () => true],
    ["iron", 8, () => true],
    ["horses", 7, (d) => d.terrain === "plains" || d.terrain === "hills"],
    ["salt", 6, () => true],
    ["furs", 5, (d) => d.terrain === "forest" || d.terrain === "tundra"],
    ["gold", 3, () => true],
    ["obsidian", 3, (d) => d.terrain === "mountains" || d.terrain === "hills"],
    ["stone_quarry", 8, (d) => d.terrain === "hills" || d.terrain === "mountains"],
  ];
  const VALID_RESOURCES = new Set<string>(RESOURCES.map(([k]) => k));
  for (const d of drafts) {
    const rng = rngFor(SEED, `${d.id}:resources`);
    const count = rng.next() < 0.6 ? 2 : 1;
    const pool = RESOURCES.filter(([, , ok]) => ok(d));
    const picked: ResourceKind[] = [];
    while (picked.length < count && pool.length > 0) {
      const idx = rng.weightedIndex(pool.map(([, w]) => w));
      picked.push(pool[idx]![0]);
      pool.splice(idx, 1);
    }
    d.resources = picked;
  }
  // Overrides, pass 2 (resources).
  overrides.forEach((o, i) => {
    if (!o.resources) return;
    for (const r of o.resources) {
      if (!VALID_RESOURCES.has(r)) throw new Error(`Override has unknown resource ${r}`);
    }
    for (const d of overrideHits[i]!) d.resources = [...new Set(o.resources)].slice(0, 2);
  });
  if (unmatched.length) console.log(`overrides with no match (${unmatched.length}): ${unmatched.join(" ")}`);

  // Step 7: sea routes.
  const distDraft = (a: Draft, b: Draft) => haversineKm(a.lat, a.lon, b.lat, b.lon);
  const coastalDrafts = drafts.filter((d) => d.coastal);
  const linkSea = (a: Draft, b: Draft) => {
    if (a === b || a.land.has(b)) return;
    a.sea.add(b);
    b.sea.add(a);
  };
  for (const d of coastalDrafts) {
    const near = coastalDrafts
      .filter((o) => o !== d && !d.land.has(o))
      .map((o) => [o, distDraft(d, o)] as const)
      .filter(([, km]) => km <= SEA_ROUTE_MAX_KM)
      .sort((x, y) => x[1] - y[1])
      .slice(0, SEA_ROUTE_COUNT);
    for (const [o] of near) linkSea(d, o);
  }
  const resolve = (spec: string): Draft[] => {
    if (!spec.includes(":")) return drafts.filter((d) => d.id === spec);
    const [cc, sub] = spec.split(":") as [string, string];
    const needle = norm(sub);
    return drafts.filter(
      (d) => d.country.iso2 === cc && (needle === "" || d.id.includes(needle) || d.aliases.some((a) => a.includes(needle))),
    );
  };
  const unmatchedRoutes: string[] = [];
  for (const e of seaRouteEntries) {
    const as = resolve(e.a);
    const bs = resolve(e.b);
    if (as.length === 0 || bs.length === 0) {
      unmatchedRoutes.push(`${e.note ?? ""} (${as.length === 0 ? e.a : e.b})`);
      continue;
    }
    let best: [Draft, Draft] | undefined;
    let bestKm = Infinity;
    for (const a of as) {
      for (const b of bs) {
        if (a === b) continue;
        const km = distDraft(a, b);
        if (km < bestKm) {
          bestKm = km;
          best = [a, b];
        }
      }
    }
    if (best) linkSea(best[0], best[1]);
  }
  if (unmatchedRoutes.length) console.log(`sea routes with no match: ${unmatchedRoutes.join("; ")}`);
  // Nothing may be isolated: connect stragglers to the nearest coastal region at any distance.
  for (const d of drafts) {
    if (d.land.size + d.sea.size > 0) continue;
    const nearest = coastalDrafts
      .filter((o) => o !== d)
      .sort((x, y) => distDraft(d, x) - distDraft(d, y))[0]!;
    console.log(`isolated ${d.id} -> sea route to ${nearest.id} (${Math.round(distDraft(d, nearest))} km)`);
    linkSea(d, nearest);
  }

  // Step 8: simplify + SVG paths, tuned to the byte budget.
  // Shared borders use one uniform weight so neighbours stay watertight; coastline arcs
  // (owned by a single province) of oversized regions get a higher per-arc threshold.
  const geoPath = d3.geoPath(projection).digits(1);
  const isPolyGeom = (g: GeometryObject): g is TopoPolygon | TopoMultiPolygon =>
    g.type === "Polygon" || g.type === "MultiPolygon";
  const arcThreshold = new Float64Array(ps.arcs.length);
  function buildPaths(sharedWeight: number): string[] {
    const arcs = ps.arcs.map((arc, i) => {
      const t = Math.max(sharedWeight, arcThreshold[i]!);
      // Drop the weight element again: merge() stitches arcs by comparing point keys.
      return arc.filter((p, j) => j === 0 || j === arc.length - 1 || p[2]! >= t).map((p) => [p[0]!, p[1]!]);
    });
    const s = topoQuantize({ type: "Topology", objects: ps.objects, arcs }, 1e4);
    const sg = s.objects.p.geometries;
    return drafts.map((d) => {
      const merged = cleanMultiPolygon(topoMerge(s, d.work.members.map((m) => sg[m]!).filter(isPolyGeom)));
      return geoPath(merged) ?? "";
    });
  }
  const total = (list: string[]) => list.reduce((acc, p) => acc + p.length, 0);
  let sharedWeight = 0.003;
  let paths = buildPaths(sharedWeight);
  for (let outer = 0; outer < 20; outer++) {
    for (let round = 0; round < 10; round++) {
      let changed = false;
      drafts.forEach((d, i) => {
        if (paths[i]!.length <= PATH_CAP_BYTES) return;
        for (const m of d.work.members) {
          for (const a of provs[m]!.arcs) {
            if (arcOwners[a]!.length !== 1) continue;
            arcThreshold[a] = Math.max(arcThreshold[a]!, sharedWeight) * 1.6;
            changed = true;
          }
        }
      });
      if (!changed) break;
      paths = buildPaths(sharedWeight);
    }
    if (total(paths) <= PATH_BUDGET_BYTES) break;
    sharedWeight *= 1.25;
    paths = buildPaths(sharedWeight);
  }
  const bytes = total(paths);
  const lens = paths.map((p) => p.length).sort((a, b) => a - b);
  console.log(
    `paths: sharedWeight=${sharedWeight.toExponential(2)} total=${(bytes / 1024).toFixed(0)} KB ` +
      `min=${lens[0]} p10=${lens[Math.floor(lens.length * 0.1)]} median=${lens[Math.floor(lens.length / 2)]} ` +
      `p90=${lens[Math.floor(lens.length * 0.9)]} max=${lens[lens.length - 1]}`,
  );

  // Step 9: assemble.
  const meanValue = drafts.reduce((s, d) => s + d.work.value, 0) / drafts.length;
  const regions: MapRegion[] = drafts.map((d, i) => {
    const [x, y] = projection([d.lon, d.lat])!;
    return {
      id: d.id,
      name: d.name,
      country: d.country.iso2,
      countryName: d.country.name,
      terrain: d.terrain,
      coastal: d.coastal,
      river: d.river,
      resources: d.resources,
      lat: +d.lat.toFixed(2),
      lon: +d.lon.toFixed(2),
      x: +x.toFixed(1),
      y: +y.toFixed(1),
      areaKm2: Math.round(d.work.areaKm2),
      value: +(d.work.value / meanValue).toFixed(3),
      neighbors: [...d.land].map((o) => o.id).sort(),
      seaRoutes: [...d.sea].map((o) => o.id).sort(),
      path: paths[i]!,
    };
  });
  const world: WorldMap = {
    version: 1,
    width: WIDTH,
    height: HEIGHT,
    generatedAt: new Date().toISOString(),
    regions,
  };
  sanityCheck(world);

  mkdirSync(SHARED_MAP_DIR, { recursive: true });
  const json =
    `{"version":1,"width":${WIDTH},"height":${HEIGHT},"generatedAt":${JSON.stringify(world.generatedAt)},"regions":[\n` +
    regions.map((r) => JSON.stringify(r)).join(",\n") +
    "\n]}\n";
  writeFileSync(WORLD_JSON, json);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, "preview.html"), previewHtml());

  // Stats.
  const count = <K extends string>(keys: K[]) => {
    const m = new Map<K, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
  };
  const perCountry = new Map<string, number>();
  for (const r of regions) perCountry.set(r.country, (perCountry.get(r.country) ?? 0) + 1);
  const topCountries = [...perCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\nregions: ${regions.length} in ${perCountry.size} countries`);
  console.log(`file: ${WORLD_JSON} (${statSync(WORLD_JSON).size} bytes)`);
  console.log(`coastal: ${regions.filter((r) => r.coastal).length}, river: ${regions.filter((r) => r.river).length}`);
  console.log(`terrain: ${count(regions.map((r) => r.terrain))}`);
  console.log(`resources: ${count(regions.flatMap((r) => r.resources))}`);
  console.log(`sea routes: ${regions.reduce((s, r) => s + r.seaRoutes.length, 0) / 2}`);
  console.log(`largest countries: ${topCountries.map(([c, n]) => `${c}=${n}`).join(" ")}`);
  const values = regions.map((r) => r.value).sort((a, b) => a - b);
  console.log(`value: min=${values[0]} p10=${values[Math.floor(values.length * 0.1)]} median=${values[Math.floor(values.length / 2)]} p90=${values[Math.floor(values.length * 0.9)]} max=${values[values.length - 1]}`);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/**
 * Simplification can leave rings with (almost) no area; d3-geo then decides the
 * polygon contains a pole and fills the whole sphere. Drop such rings and make
 * sure exteriors and holes wind the way d3-geo expects.
 */
function cleanMultiPolygon(geom: MultiPolygon): MultiPolygon {
  const TWO_PI = 2 * Math.PI;
  const polygons: number[][][][] = [];
  for (const rings of geom.coordinates) {
    const cleaned: number[][][] = [];
    for (const ring of rings) {
      const pts: number[][] = [];
      for (const p of ring) {
        const last = pts[pts.length - 1];
        if (last && last[0] === p[0] && last[1] === p[1]) continue;
        pts.push([p[0]!, p[1]!]);
      }
      const first = pts[0];
      const lastPt = pts[pts.length - 1];
      if (first && lastPt && (first[0] !== lastPt[0] || first[1] !== lastPt[1])) pts.push([first[0]!, first[1]!]);
      if (pts.length < 4) continue;
      let area2 = 0;
      for (let i = 1; i < pts.length; i++) area2 += pts[i - 1]![0]! * pts[i]![1]! - pts[i]![0]! * pts[i - 1]![1]!;
      if (Math.abs(area2) < 2e-7) continue;
      cleaned.push(pts);
    }
    if (cleaned.length === 0) continue;
    const ext = cleaned[0]!;
    if (d3.geoArea({ type: "Polygon", coordinates: [ext] }) > TWO_PI) ext.reverse();
    for (let i = 1; i < cleaned.length; i++) {
      if (d3.geoArea({ type: "Polygon", coordinates: [cleaned[i]!] }) < TWO_PI) cleaned[i]!.reverse();
    }
    polygons.push(cleaned);
  }
  return { type: "MultiPolygon", coordinates: polygons as MultiPolygon["coordinates"] };
}

function sanityCheck(w: WorldMap): void {
  const ids = new Map<string, MapRegion>();
  for (const r of w.regions) {
    if (ids.has(r.id)) throw new Error(`duplicate id ${r.id}`);
    ids.set(r.id, r);
  }
  for (const r of w.regions) {
    if (r.neighbors.length + r.seaRoutes.length === 0) throw new Error(`${r.id} isolated`);
    if (r.resources.length < 1 || r.resources.length > 2) throw new Error(`${r.id} has ${r.resources.length} resources`);
    if (!r.path.startsWith("M")) throw new Error(`${r.id} has an empty path`);
    for (const k of ["neighbors", "seaRoutes"] as const) {
      for (const n of r[k]) {
        const o = ids.get(n);
        if (!o) throw new Error(`${r.id} -> unknown ${n}`);
        if (!o[k].includes(r.id)) throw new Error(`asymmetric ${k} ${r.id} -> ${n}`);
      }
    }
  }
}

function previewHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Last Thaw map preview</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #1b2838; color: #eee; font: 13px/1.4 system-ui, sans-serif; }
  #wrap { position: relative; }
  svg { width: 100%; height: auto; display: block; background: #244c6b; }
  path { stroke: #0e1a24; stroke-width: 0.6; cursor: pointer; }
  path:hover { stroke: #fff; stroke-width: 1.5; }
  line { stroke: #ffe28a; stroke-width: 0.7; stroke-dasharray: 4 3; opacity: 0.8; pointer-events: none; }
  #tip { position: fixed; pointer-events: none; background: rgba(0,0,0,.85); padding: 6px 9px; border-radius: 4px; display: none; max-width: 320px; }
  #legend { padding: 8px 12px; display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
  #legend span::before { content: ""; display: inline-block; width: 12px; height: 12px; margin-right: 4px; vertical-align: -1px; background: var(--c); }
</style>
</head>
<body>
<div id="legend"></div>
<div id="wrap"><svg id="map" viewBox="0 0 ${WIDTH} ${HEIGHT}"></svg></div>
<div id="tip"></div>
<script>
const COLORS = { plains: "#b9c96a", forest: "#3d7a3a", hills: "#a98c57", mountains: "#8a8a8a", desert: "#e3c77a", tundra: "#d8e3e8", wetland: "#5aa39a" };
const legend = document.getElementById("legend");
for (const [k, c] of Object.entries(COLORS)) { const s = document.createElement("span"); s.style.setProperty("--c", c); s.textContent = k; legend.appendChild(s); }
const stats = document.createElement("span"); stats.id = "stats"; legend.appendChild(stats);
const svg = document.getElementById("map"), tip = document.getElementById("tip"), NS = "http://www.w3.org/2000/svg";
fetch("../../../packages/shared/src/map/world.json").then(r => r.json()).then(world => {
  const byId = new Map(world.regions.map(r => [r.id, r]));
  const gRoutes = document.createElementNS(NS, "g"), gLand = document.createElementNS(NS, "g");
  svg.append(gLand, gRoutes);
  for (const r of world.regions) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", r.path); p.setAttribute("fill", COLORS[r.terrain] || "#f0f");
    p.addEventListener("mousemove", e => {
      tip.style.display = "block"; tip.style.left = (e.clientX + 14) + "px"; tip.style.top = (e.clientY + 14) + "px";
      tip.innerHTML = "<b>" + r.id + "</b><br>" + r.name + " (" + r.countryName + ")<br>" + r.terrain +
        (r.coastal ? ", coastal" : "") + (r.river ? ", river" : "") + "<br>resources: " + r.resources.join(", ") +
        "<br>neighbors: " + r.neighbors.length + " land, " + r.seaRoutes.length + " sea<br>value " + r.value + ", " + r.areaKm2.toLocaleString() + " km2";
    });
    p.addEventListener("mouseleave", () => tip.style.display = "none");
    gLand.appendChild(p);
  }
  const seen = new Set();
  for (const r of world.regions) for (const id of r.seaRoutes) {
    const key = [r.id, id].sort().join("|"); if (seen.has(key)) continue; seen.add(key);
    const o = byId.get(id); if (!o) continue;
    const segs = Math.abs(r.x - o.x) > ${WIDTH / 2}
      ? (r.x < o.x ? [[r.x, r.y, 0, (r.y + o.y) / 2], [${WIDTH}, (r.y + o.y) / 2, o.x, o.y]] : [[r.x, r.y, ${WIDTH}, (r.y + o.y) / 2], [0, (r.y + o.y) / 2, o.x, o.y]])
      : [[r.x, r.y, o.x, o.y]];
    for (const [x1, y1, x2, y2] of segs) {
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", x1); l.setAttribute("y1", y1); l.setAttribute("x2", x2); l.setAttribute("y2", y2);
      gRoutes.appendChild(l);
    }
  }
  stats.textContent = world.regions.length + " regions, " + world.regions.filter(r => r.coastal).length + " coastal, " + seen.size + " sea routes, generated " + world.generatedAt;
}).catch(e => { legend.textContent = "Failed to load world.json (serve the repo root over http): " + e; });
</script>
</body>
</html>
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
