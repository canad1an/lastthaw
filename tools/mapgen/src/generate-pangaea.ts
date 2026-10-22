/**
 * Pangaea map generator.
 *
 * The supercontinent of 250 million years ago, cut into ~400 regions. Source: PaleoMAP PaleoCoastlines v7
 * (Kocsis & Scotese 2021, CC BY 4.0), the 250 Ma coastline polygons in paleo-longitude/latitude, in
 * tools/mapgen/data/pangaea-src/CS/250Ma_CS_v7.shp (see tools/mapgen/README.md for the download).
 *
 * Seeds are scattered over the land in proportion to its "value" (true area, less toward the poles, like Earth's
 * map), relaxed a few times, and the land is cut along their Voronoi cells. Cells too small for a region are
 * dropped and their land goes to the neighbours. Every region gets a latitude-band terrain with an arid interior
 * (Pangaea's heart was far from any sea), resources by the same table as Earth, an invented name in the tongue of
 * its land (nine lands, named for the old cratons), lanes to its nearest coasts, and an SVG path in the same
 * 2000 x 1000 equirectangular box as Earth. Deterministic from SEED.
 *
 * Usage: npx tsx tools/mapgen/src/generate-pangaea.ts
 * Writes packages/shared/src/map/pangaea.json and apps/web/public/map/pangaea/world.json. Then run the post-steps
 * with --map pangaea: dense-lanes.mjs, sea-paths.mjs, and coast-points.mjs (see README).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Delaunay } from "d3-delaunay";
import polygonClipping, { type MultiPolygon as ClipMultiPolygon, type Polygon as ClipPolygon, type Ring as ClipRing } from "polygon-clipping";
import * as shapefile from "shapefile";
import type { MapRegion, ResourceKind, Terrain, WorldMap } from "../../../packages/shared/src/map/types.js";
import { rngFor } from "./rng.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "data", "pangaea-src", "CS", "250Ma_CS_v7.shp");
const OUT_SHARED = path.resolve(ROOT, "..", "..", "packages", "shared", "src", "map", "pangaea.json");
const OUT_WEB = path.resolve(ROOT, "..", "..", "apps", "web", "public", "map", "pangaea", "world.json");

const SEED = "pangaea-1";
const TARGET = 520; // seeds; about a fifth are slivers that get dropped, leaving ~400 regions
const WIDTH = 2000;
const HEIGHT = 1000;
const KM_PER_UNIT = 40075 / WIDTH; // at the equator
const SEA_ROUTE_MAX_KM = 2500;
const SEA_ROUTE_COUNT = 2;
/** Cells worth less than this share of the mean are dropped so their land joins the neighbours. */
const MIN_VALUE_SHARE = 0.3;
/** Interior this far from any coast (map units, about 1700 km) is arid in the lower latitudes. */
const ARID_FROM_COAST = 85;

type Pt = [number, number];
type Poly = Pt[][]; // rings: first outer, rest holes

const project = (lon: number, lat: number): Pt => [((lon + 180) / 360) * WIDTH, ((90 - lat) / 180) * HEIGHT];
const unproject = (x: number, y: number) => ({ lon: (x / WIDTH) * 360 - 180, lat: 90 - (y / HEIGHT) * 180 });
const latOf = (y: number) => 90 - (y / HEIGHT) * 180;

function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] + r[i]![0]) * (r[j]![1] - r[i]![1]);
  return Math.abs(a) / 2;
}
function polyArea(p: Poly): number {
  return p.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * ringArea(r), 0);
}
function multiArea(m: Poly[]): number {
  return m.reduce((s, p) => s + Math.max(0, polyArea(p)), 0);
}
function centroid(m: Poly[]): Pt {
  let sx = 0, sy = 0, sa = 0;
  for (const p of m) {
    const r = p[0]!;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
      a += f;
      cx += (r[j]![0] + r[i]![0]) * f;
      cy += (r[j]![1] + r[i]![1]) * f;
    }
    if (Math.abs(a) < 1e-9) continue;
    sx += cx / 3;
    sy += cy / 3;
    sa += a;
  }
  return sa === 0 ? [0, 0] : [sx / sa, sy / sa];
}
function inRing(p: Pt, ring: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function inMulti(p: Pt, m: Poly[]): boolean {
  for (const poly of m) {
    if (!inRing(p, poly[0]!)) continue;
    if (poly.slice(1).some((h) => inRing(p, h))) continue;
    return true;
  }
  return false;
}
/** Earth's latitude factor: land near the poles counts for less, so it gets fewer, larger regions. */
function latitudeFactor(absLat: number): number {
  return absLat < 50 ? 1 : absLat < 60 ? 0.6 : absLat < 70 ? 0.25 : 0.05;
}
/** True area of a projected ring in km², using the latitude of its points for the east-west stretch. */
function kmArea(m: Poly[]): number {
  let total = 0;
  for (const poly of m) {
    poly.forEach((ring, idx) => {
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const cos = Math.cos((latOf((ring[i]![1] + ring[j]![1]) / 2) * Math.PI) / 180);
        a += (ring[j]![0] + ring[i]![0]) * (ring[j]![1] - ring[i]![1]) * cos;
      }
      total += (idx === 0 ? 1 : -1) * (Math.abs(a) / 2);
    });
  }
  return total * KM_PER_UNIT * KM_PER_UNIT * (HEIGHT / WIDTH) * 2; // y units are 180°/1000, x units 360°/2000: same scale
}
const toClip = (m: Poly[]): ClipMultiPolygon => m.map((p) => p.map((r) => r.map(([x, y]) => [x, y] as [number, number]) as ClipRing) as ClipPolygon);
const fromClip = (m: ClipMultiPolygon): Poly[] => m.map((p) => p.map((r) => r.map(([x, y]) => [x, y] as Pt)));
const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

/** The names of the lands (the old cratons, placed where they sat at 250 Ma) and the sounds of each land's tongue. */
const LANDS: Array<{ code: string; name: string; at: [number, number]; onsets: string[]; nuclei: string[]; codas: string[] }> = [
  { code: "lau", name: "Laurentia", at: [-45, 25], onsets: ["k", "th", "r", "m", "n", "d", "v", "h", "l", "br"], nuclei: ["a", "e", "i", "o", "ai", "au"], codas: ["n", "r", "th", "l", "s", "d", ""] },
  { code: "bal", name: "Baltica", at: [5, 45], onsets: ["s", "v", "k", "t", "g", "n", "l", "st", "hr"], nuclei: ["a", "e", "i", "o", "u", "ei"], codas: ["r", "n", "nd", "ld", "k", "s", ""] },
  { code: "sib", name: "Siberia", at: [70, 65], onsets: ["t", "k", "y", "b", "ch", "s", "m", "kh", "n"], nuclei: ["a", "u", "o", "e", "i", "aa"], codas: ["k", "n", "t", "r", "l", "m", ""] },
  { code: "kaz", name: "Kazakhstania", at: [40, 35], onsets: ["k", "t", "zh", "b", "sh", "r", "m", "d"], nuclei: ["a", "u", "o", "e", "i"], codas: ["k", "n", "z", "r", "l", "t", ""] },
  { code: "cat", name: "Cathaysia", at: [110, 15], onsets: ["x", "l", "w", "f", "h", "sh", "y", "ch", "m"], nuclei: ["a", "i", "u", "e", "o", "ao"], codas: ["n", "ng", "", "", "i"] },
  { code: "cim", name: "Cimmeria", at: [75, -15], onsets: ["s", "p", "r", "n", "m", "t", "dh", "k", "l"], nuclei: ["a", "i", "u", "e", "o", "ar"], codas: ["r", "sh", "n", "t", "m", "", ""] },
  { code: "afr", name: "Gondwana", at: [15, -25], onsets: ["m", "k", "n", "b", "z", "g", "t", "l", "w", "nd"], nuclei: ["a", "o", "u", "e", "i"], codas: ["", "", "n", "m", "r", "s"] },
  { code: "sam", name: "Amazonia", at: [-45, -30], onsets: ["p", "t", "k", "m", "y", "x", "ch", "n", "w"], nuclei: ["a", "i", "u", "e", "o"], codas: ["", "", "n", "r", "y", "c"] },
  { code: "ant", name: "Australia", at: [110, -60], onsets: ["w", "k", "n", "m", "y", "b", "d", "ng", "t"], nuclei: ["a", "u", "i", "o", "e", "oo"], codas: ["", "", "n", "r", "l", "ng"] },
];

function makeName(land: (typeof LANDS)[number], rng: { next(): number }): string {
  const pick = <T,>(arr: T[]) => arr[Math.floor(rng.next() * arr.length)]!;
  const syllables = 2 + (rng.next() < 0.35 ? 1 : 0);
  let out = "";
  for (let i = 0; i < syllables; i++) out += pick(land.onsets) + pick(land.nuclei) + (i === syllables - 1 || rng.next() < 0.3 ? pick(land.codas) : "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

async function loadLand(): Promise<Poly[]> {
  const src = await shapefile.open(SRC);
  const out: Poly[] = [];
  for (;;) {
    const r = await src.read();
    if (r.done) break;
    const g = r.value.geometry as { type: string; coordinates: number[][][] | number[][][][] };
    const polys = g.type === "Polygon" ? [g.coordinates as number[][][]] : (g.coordinates as number[][][][]);
    for (const poly of polys) out.push(poly.map((ring) => ring.map(([lon, lat]) => project(lon!, lat!))));
  }
  // Union everything so overlapping pieces become one landmass with clean holes.
  const [first, ...rest] = out.map((p) => [toClip([p])[0]!] as ClipMultiPolygon);
  return fromClip(polygonClipping.union(first!, ...rest));
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const land = await loadLand();
  const landClip = toClip(land);
  const landKm2 = kmArea(land);
  console.log(`land: ${land.length} polygons, ${Math.round(landKm2 / 1e6)} million km²`);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const p of land) for (const [x, y] of p[0]!) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }

  // Seeds in proportion to value: rejection sampling over the land with the latitude factor and cos(lat) (true area).
  const rng = rngFor(SEED, "seeds");
  const seeds: Pt[] = [];
  let tries = 0;
  while (seeds.length < TARGET && tries < 2_000_000) {
    tries++;
    const p: Pt = [bx0 + rng.next() * (bx1 - bx0), by0 + rng.next() * (by1 - by0)];
    const lat = latOf(p[1]);
    if (rng.next() > latitudeFactor(Math.abs(lat)) * Math.cos((lat * Math.PI) / 180)) continue;
    if (!inMulti(p, land)) continue;
    seeds.push(p);
  }
  console.log(`seeds: ${seeds.length} after ${tries} tries`);

  // Cut, relax, drop the slivers, repeat.
  type Cell = { seed: Pt; shape: Poly[]; km2: number; value: number; neighbours: Set<number>; coastal: boolean };
  let cells: Cell[] = [];
  const cut = (pts: Pt[]): Cell[] => {
    const voronoi = Delaunay.from(pts).voronoi([0, 0, WIDTH, HEIGHT]);
    return pts.map((seed, i) => {
      const raw = voronoi.cellPolygon(i);
      const cell = raw ? (raw as Pt[]) : [];
      const shape = cell.length >= 4 ? fromClip(polygonClipping.intersection([[cell.map(([x, y]) => [x, y] as [number, number]) as ClipRing] as ClipPolygon], landClip)) : [];
      const km2 = kmArea(shape);
      const c = centroid(shape);
      const value = km2 * latitudeFactor(Math.abs(latOf(c[1] || seed[1])));
      const rawArea = cell.length >= 4 ? ringArea(cell) : 0;
      return { seed, shape, km2, value, neighbours: new Set([...voronoi.neighbors(i)]), coastal: multiArea(shape) < rawArea - 1e-3 };
    });
  };
  let pts = seeds;
  for (let round = 0; round < 8; round++) {
    cells = cut(pts);
    const mean = cells.reduce((s, c) => s + c.value, 0) / cells.length;
    const keep = cells.filter((c) => c.shape.length > 0 && c.value >= mean * MIN_VALUE_SHARE);
    const dropped = cells.length - keep.length;
    // Lloyd relaxation: each seed moves to its cell's centroid (kept inside the land, else it stays put).
    pts = keep.map((c) => {
      const cen = centroid(c.shape);
      return inMulti(cen, land) ? cen : c.seed;
    });
    console.log(`round ${round}: ${cells.length} cells, dropped ${dropped}`);
    if (dropped === 0 && round >= 3) break;
  }
  cells = cut(pts);
  // Adjacency by shared boundary: two Delaunay neighbours are land neighbours when their clipped shapes share an edge.
  const keyOf = ([x, y]: Pt) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const vertexKeys = cells.map((c) => new Set(c.shape.flatMap((p) => p.flatMap((r) => r.map(keyOf)))));
  const land_nb = cells.map((c, i) => [...c.neighbours].filter((j) => j !== i && j >= 0 && j < cells.length && [...vertexKeys[i]!].filter((k) => vertexKeys[j]!.has(k)).length >= 2));
  // Distance to the coast, for the arid interior: the nearest coastal cell's centroid, in map units.
  const centres = cells.map((c) => centroid(c.shape));
  const coastIdx = cells.map((c, i) => i).filter((i) => cells[i]!.coastal);
  const coastDist = centres.map((p, i) => (cells[i]!.coastal ? 0 : Math.min(...coastIdx.map((j) => Math.hypot(centres[j]![0] - p[0], centres[j]![1] - p[1])))));

  // Lands: each region belongs to the land whose seat is nearest (in map units).
  const landOf = centres.map((p) => {
    let best = 0, bd = Infinity;
    LANDS.forEach((l, i) => {
      const q = project(l.at[0], l.at[1]);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  });

  // Names, unique across the map.
  const used = new Set<string>();
  const names = cells.map((_, i) => {
    const r = rngFor(SEED, `name:${i}:${Math.round(centres[i]![0])}:${Math.round(centres[i]![1])}`);
    for (let k = 0; k < 50; k++) {
      const n = makeName(LANDS[landOf[i]!]!, r);
      if (!used.has(n.toLowerCase())) { used.add(n.toLowerCase()); return n; }
    }
    throw new Error("ran out of names");
  });
  const ids = names.map((n) => `pg-${n.toLowerCase().replace(/[^a-z]+/g, "-")}`);

  // Terrain: Earth's latitude bands, with the deep interior turned to desert in the lower latitudes and mountains a touch likelier inland.
  const BANDS: Array<[number, Array<[Terrain, number]>]> = [
    [15, [["forest", 45], ["plains", 25], ["hills", 15], ["wetland", 15]]],
    [35, [["plains", 40], ["hills", 25], ["desert", 10], ["forest", 15], ["mountains", 10]]],
    [50, [["forest", 35], ["plains", 30], ["hills", 20], ["mountains", 15]]],
    [62, [["forest", 55], ["plains", 20], ["hills", 15], ["mountains", 10]]],
  ];
  const terrains: Terrain[] = cells.map((_, i) => {
    const r = rngFor(SEED, `${ids[i]}:terrain`);
    const lat = Math.abs(latOf(centres[i]![1]));
    if (lat > 62) return "tundra";
    const inland = coastDist[i]! / ARID_FROM_COAST; // 1 at the arid threshold
    if (lat < 40 && inland > 0.7 && r.next() < Math.min(0.8, inland - 0.6)) return "desert";
    const band = BANDS.find(([max]) => lat < max)![1].map(([t, w]) => [t, t === "mountains" && inland > 0.4 ? w * 1.6 : w] as [Terrain, number]);
    return band[r.weightedIndex(band.map(([, w]) => w))]![0];
  });
  const rivers = cells.map((_, i) => rngFor(SEED, `${ids[i]}:river`).next() < 0.3);
  const RESOURCES: Array<[ResourceKind, number, (i: number) => boolean]> = [
    ["fertile_soil", 18, () => true],
    ["timber", 14, () => true],
    ["flint", 10, () => true],
    ["fish", 10, (i) => cells[i]!.coastal || rivers[i]!],
    ["copper", 8, () => true],
    ["tin", 5, () => true],
    ["iron", 8, () => true],
    ["horses", 7, (i) => terrains[i] === "plains" || terrains[i] === "hills"],
    ["salt", 6, () => true],
    ["furs", 5, (i) => terrains[i] === "forest" || terrains[i] === "tundra"],
    ["gold", 3, () => true],
    ["obsidian", 3, (i) => terrains[i] === "mountains" || terrains[i] === "hills"],
    ["stone_quarry", 8, (i) => terrains[i] === "hills" || terrains[i] === "mountains"],
  ];
  const resources = cells.map((_, i) => {
    const r = rngFor(SEED, `${ids[i]}:resources`);
    const count = r.next() < 0.6 ? 2 : 1;
    const pool = RESOURCES.filter(([, , ok]) => ok(i));
    const picked: ResourceKind[] = [];
    while (picked.length < count && pool.length > 0) {
      const idx = r.weightedIndex(pool.map(([, w]) => w));
      picked.push(pool[idx]![0]);
      pool.splice(idx, 1);
    }
    return picked;
  });

  // Sea routes: each coastal region to its nearest coastal non-neighbours by great circle, as Earth's first pass.
  const geo = centres.map(([x, y]) => unproject(x, y));
  const km = (a: number, b: number) => {
    const toRad = Math.PI / 180;
    const dLat = (geo[b]!.lat - geo[a]!.lat) * toRad;
    const dLon = (geo[b]!.lon - geo[a]!.lon) * toRad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(geo[a]!.lat * toRad) * Math.cos(geo[b]!.lat * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const sea = cells.map(() => new Set<number>());
  for (const i of coastIdx) {
    const near = coastIdx.filter((j) => j !== i && !land_nb[i]!.includes(j)).map((j) => [j, km(i, j)] as const).filter(([, d]) => d <= SEA_ROUTE_MAX_KM).sort((a, b) => a[1] - b[1]).slice(0, SEA_ROUTE_COUNT);
    for (const [j] of near) { sea[i]!.add(j); sea[j]!.add(i); }
  }
  cells.forEach((_, i) => {
    if (land_nb[i]!.length + sea[i]!.size > 0) return;
    const nearest = coastIdx.filter((j) => j !== i).sort((a, b) => km(i, a) - km(i, b))[0]!;
    console.log(`isolated ${ids[i]} -> sea route to ${ids[nearest]}`);
    sea[i]!.add(nearest);
    sea[nearest]!.add(i);
  });

  // Paths, anchors and extents.
  const pathOf = (m: Poly[]) => m.map((p) => p.map((r) => "M" + r.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L") + "Z").join("")).join("");
  const anchorOf = (m: Poly[]): Pt => {
    const biggest = [...m].sort((a, b) => polyArea(b) - polyArea(a))[0]!;
    const c = centroid([biggest]);
    if (inRing(c, biggest[0]!) && !biggest.slice(1).some((h) => inRing(c, h))) return c;
    // Not inside: the midpoint of the longest run of the ring's interior along the centroid's row.
    const ring = biggest[0]!;
    const xs: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > c[1] !== yj > c[1]) xs.push(xi + ((c[1] - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    let best: Pt = c, bw = -1;
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1]! - xs[k]! > bw) { bw = xs[k + 1]! - xs[k]!; best = [(xs[k]! + xs[k + 1]!) / 2, c[1]]; }
    return best;
  };
  const meanValue = cells.reduce((s, c) => s + c.value, 0) / cells.length;
  const regions: MapRegion[] = cells.map((c, i) => {
    const [ax, ay] = anchorOf(c.shape);
    let y0 = Infinity, y1 = -Infinity;
    for (const p of c.shape) for (const [, y] of p[0]!) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const landDef = LANDS[landOf[i]!]!;
    return {
      id: ids[i]!,
      name: names[i]!,
      country: landDef.code,
      countryName: landDef.name,
      terrain: terrains[i]!,
      coastal: c.coastal,
      river: rivers[i]!,
      resources: resources[i]!,
      lat: +geo[i]!.lat.toFixed(2),
      lon: +geo[i]!.lon.toFixed(2),
      latNorth: +latOf(y0).toFixed(2),
      latSouth: +latOf(y1).toFixed(2),
      x: +ax.toFixed(1),
      y: +ay.toFixed(1),
      areaKm2: Math.round(c.km2),
      value: +(c.value / meanValue).toFixed(3),
      neighbors: land_nb[i]!.map((j) => ids[j]!).sort(),
      seaRoutes: [...sea[i]!].map((j) => ids[j]!).sort(),
      path: pathOf(c.shape),
    };
  });
  const world: WorldMap = { version: 1, width: WIDTH, height: HEIGHT, generatedAt: new Date().toISOString(), regions };
  // Sanity.
  const byId = new Map(regions.map((r) => [r.id, r]));
  for (const r of regions) {
    if (!r.path.startsWith("M")) throw new Error(`${r.id}: empty path`);
    if (r.resources.length < 1) throw new Error(`${r.id}: no resources`);
    for (const n of r.neighbors) if (!byId.get(n)?.neighbors.includes(r.id)) throw new Error(`${r.id}: asymmetric neighbour ${n}`);
    for (const n of r.seaRoutes) if (!byId.get(n)?.seaRoutes.includes(r.id)) throw new Error(`${r.id}: asymmetric lane ${n}`);
    if (r.neighbors.length + r.seaRoutes.length === 0) throw new Error(`${r.id}: isolated`);
  }
  const json = `{"version":1,"width":${WIDTH},"height":${HEIGHT},"generatedAt":${JSON.stringify(world.generatedAt)},"regions":[\n` + regions.map((r) => JSON.stringify(r)).join(",\n") + "\n]}\n";
  writeFileSync(OUT_SHARED, json);
  mkdirSync(path.dirname(OUT_WEB), { recursive: true });
  writeFileSync(OUT_WEB, json);
  const count = (keys: string[]) => { const m = new Map<string, number>(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "); };
  console.log(`regions: ${regions.length}; coastal ${regions.filter((r) => r.coastal).length}; paths ${Math.round(regions.reduce((s, r) => s + r.path.length, 0) / 1024)} KB`);
  console.log(`terrain: ${count(regions.map((r) => r.terrain))}`);
  console.log(`lands: ${count(regions.map((r) => r.countryName))}`);
  console.log(`sea routes: ${regions.reduce((s, r) => s + r.seaRoutes.length, 0) / 2}; done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
