/**
 * Lanes that follow the water.
 *
 * The map is rasterised into land and sea (sea is anywhere no region's outline covers). For every sea lane the shortest
 * water path between the two regions' shores is found on that grid; a lane whose water path is far longer than the
 * straight line (a "lane" that really marches across a continent) or that has no water path at all is dropped. The seas
 * are then joined: from each separate piece, the nearest shore of another piece by water becomes a new lane, until the
 * sea is one. Before that, every coast gets lanes to its NEAR_COUNT nearest other coasts by water within NEAR_WATER_KM,
 * found by sailing outward from its shore on the grid, so lanes follow straits and coastlines rather than the ruler. Every surviving lane's water path, simplified, is written to apps/web/src/map/lanePaths.json so ships are
 * drawn sailing along the water, shore to shore. world.json's seaRoutes are updated to the surviving set, and each
 * region records which stretch of its own coast every lane of its leaves from, so a voyage never passes through a region
 * from one coast to another that the sea does not join along its shore: Egypt touches the Red Sea and the Mediterranean,
 * but a ship at its Red Sea shore does not step across to the Mediterranean one.
 * Deterministic. Run: node tools/mapgen/src/sea-paths.mjs [--dry]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DRY = process.argv.includes("--dry");
const MAP = process.argv.find((a) => a.startsWith("--map="))?.slice(6) ?? "earth";
const SCALE = 2; // grid cells per map unit: 4000 x 2000 cells over the 2000 x 1000 map, about 10 km a cell at the equator
/** Narrow straits the outlines pinch shut at this resolution, carved open as water: [lon, lat] to [lon, lat]. */
const STRAITS = [
  ["Gibraltar", [-5.9, 35.8], [-5.2, 36.2]],
  ["Bosporus and Dardanelles", [26.1, 40.0], [29.3, 41.3]],
  ["Kerch", [36.4, 44.9], [36.7, 45.5]],
  ["Bab-el-Mandeb", [43.2, 12.5], [43.5, 12.9]],
  ["Hormuz", [56.0, 26.2], [56.8, 26.9]],
  ["Malacca", [100.2, 3.0], [103.9, 1.2]],
  ["Oresund", [12.4, 55.5], [12.9, 56.2]],
  ["Dover", [1.3, 50.9], [1.9, 51.1]],
  ["Messina", [15.5, 37.9], [15.7, 38.3]],
  ["Bering", [-171.5, 65.2], [-167.0, 66.3]],
];
const MAX_RATIO = 2.6; // a lane may be at most this many times longer by water than as the crow flies
const KEEP_EVERY = 8; // simplification: keep every n-th point of a water path
const NEAR_COUNT = 4; // lanes each coast gets to its nearest coasts by water...
const NEAR_WATER_KM = 1500; // ...within this sailing distance

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORLD = path.join(ROOT, "packages", "shared", "src", "map", MAP === "earth" ? "world.json" : `${MAP}.json`);
// Earth's drawing data is bundled with the web app; other maps are fetched from /map/<id>/ when a match on them opens.
const OUT = MAP === "earth" ? path.join(ROOT, "apps", "web", "src", "map", "earth", "lanePaths.json") : path.join(ROOT, "apps", "web", "public", "map", MAP, "lanePaths.json");
const world = JSON.parse(readFileSync(WORLD, "utf8"));
const byId = new Map(world.regions.map((r) => [r.id, r]));
const W = Math.round(world.width * SCALE);
const H = Math.round(world.height * SCALE);

// ---- Rasterise: owner[cell] = region index + 1, or 0 for sea.
function rings(d) {
  const out = [];
  let ring = [];
  let x = 0, y = 0, cmd = "";
  const nums = [];
  const re = /([MLHVZmlhvz])|(-?\d*\.?\d+)/g;
  let m;
  const flush = () => {
    while (nums.length) {
      if (cmd === "M") { if (ring.length) out.push(ring); ring = []; x = nums.shift(); y = nums.shift(); ring.push([x, y]); cmd = "L"; }
      else if (cmd === "L") { x = nums.shift(); y = nums.shift(); ring.push([x, y]); }
      else if (cmd === "H") { x = nums.shift(); ring.push([x, y]); }
      else if (cmd === "V") { y = nums.shift(); ring.push([x, y]); }
      else nums.length = 0;
    }
  };
  while ((m = re.exec(d))) {
    if (m[1]) { flush(); cmd = m[1].toUpperCase(); if (cmd === "Z") { if (ring.length) out.push(ring); ring = []; } }
    else nums.push(Number(m[2]));
  }
  flush();
  if (ring.length) out.push(ring);
  return out.filter((r) => r.length >= 3);
}
const owner = new Uint16Array(W * H);
world.regions.forEach((r, idx) => {
  for (const ring of rings(r.path)) {
    // Scanline fill, even-odd, one ring at a time (holes in these outlines are rare and small).
    const ys = ring.map((p) => p[1] * SCALE);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) {
      const cy = y + 0.5;
      const xs = [];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = [ring[i][0] * SCALE, ring[i][1] * SCALE];
        const [xj, yj] = [ring[j][0] * SCALE, ring[j][1] * SCALE];
        if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.round(xs[k]));
        const xb = Math.min(W - 1, Math.round(xs[k + 1]) - 1);
        for (let x = xa; x <= xb; x++) owner[y * W + x] = idx + 1;
      }
    }
  }
});
// The straits: a line of water through each, three cells wide.
const cellOf = (lon, lat) => [Math.round(((lon + 180) / 360) * W), Math.round(((90 - lat) / 180) * H)];
for (const [, a, b] of MAP === "earth" ? STRAITS : []) {
  const [x0, y0] = cellOf(a[0], a[1]);
  const [x1, y1] = cellOf(b[0], b[1]);
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      owner[yy * W + ((x + dx + W) % W)] = 0;
    }
  }
}
const regionIndex = new Map(world.regions.map((r, i) => [r.id, i + 1]));
// Shore cells of a region: its land cells with a sea cell beside them (8 neighbours, x wrapping at the map's edge).
const shoreOf = new Map();
const nbr = (c) => {
  const x = c % W, y = (c - x) / W;
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const ny = y + dy;
    if (ny < 0 || ny >= H) continue;
    const nx = (x + dx + W) % W;
    out.push(ny * W + nx);
  }
  return out;
};
for (const r of world.regions) {
  if (!r.coastal) continue;
  const id = regionIndex.get(r.id);
  const cells = [];
  for (let c = 0; c < owner.length; c++) if (owner[c] === id && nbr(c).some((n) => owner[n] === 0)) cells.push(c);
  shoreOf.set(r.id, cells);
}
// Coast segments: a region's shore cells grouped by the water in front of them. Two shore cells belong to the same
// stretch when the sea joins them within the region's own bounds (plus a margin), so islets, keys and river mouths
// do not split a coast, while two coasts with land between them (Egypt's Red Sea and Mediterranean shores, Panama's
// two oceans) stay apart: the sea does not join them anywhere near.
const MARGIN = 30; // cells, about 300 km
const coastSeg = new Map(); // shore cell -> segment id (unique across regions)
let segments = 0;
{
  const near = new Int32Array(W * H).fill(-1);
  for (const [id, cells] of shoreOf) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cells) { const x = c % W, y = (c - x) / W; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    // A region spanning the map's edge gets the whole width; nothing else does.
    const wide = x1 - x0 > W / 2;
    const bx0 = wide ? 0 : Math.max(0, x0 - MARGIN), bx1 = wide ? W - 1 : Math.min(W - 1, x1 + MARGIN);
    const by0 = Math.max(0, y0 - MARGIN), by1 = Math.min(H - 1, y1 + MARGIN);
    const inBox = (c) => { const x = c % W, y = (c - x) / W; return x >= bx0 && x <= bx1 && y >= by0 && y <= by1; };
    const touched = [];
    for (const c of cells) {
      const start = nbr(c).find((n) => owner[n] === 0);
      if (start === undefined || near[start] >= 0) continue;
      const seg = segments++;
      const q = [start];
      near[start] = seg; touched.push(start);
      while (q.length) {
        const x = q.pop();
        for (const n of nbr(x)) if (owner[n] === 0 && near[n] < 0 && inBox(n)) { near[n] = seg; touched.push(n); q.push(n); }
      }
    }
    for (const c of cells) {
      const n = nbr(c).find((m) => owner[m] === 0 && near[m] >= 0);
      if (n !== undefined) coastSeg.set(c, near[n]);
    }
    for (const n of touched) near[n] = -1;
    void id;
  }
}
/** The coast segment of region `id` that a water path touches at its given end cell. */
function coastAt(id, seaCell) {
  const want = regionIndex.get(id);
  for (const n of nbr(seaCell)) if (owner[n] === want && coastSeg.has(n)) return coastSeg.get(n);
  return -1;
}
const rad = (x) => (x * Math.PI) / 180;
const km = (a, b) => {
  const A = byId.get(a), B = byId.get(b);
  return 2 * 6371 * Math.asin(Math.sqrt(Math.sin(rad(B.lat - A.lat) / 2) ** 2 + Math.cos(rad(A.lat)) * Math.cos(rad(B.lat)) * Math.sin(rad(B.lon - A.lon) / 2) ** 2));
};
const cellKm = (c) => {
  // Kilometres per cell at this latitude: the map is equirectangular.
  const y = Math.floor(c / W);
  const lat = 90 - (y / H) * 180;
  return (40075 / W) * Math.cos(rad(lat));
};

/**
 * Breadth-first over sea cells from one region's shore to another's (or to any shore of a set of target regions).
 * Returns the water path as cells, sea cells only, from the sea beside the start shore to the sea beside the target shore.
 */
const dist = new Int32Array(W * H);
const prev = new Int32Array(W * H);
function waterPath(fromIds, toIds) {
  dist.fill(-1);
  const targets = new Uint8Array(W * H);
  for (const id of toIds) for (const c of shoreOf.get(id) ?? []) for (const n of nbr(c)) if (owner[n] === 0) targets[n] = 1;
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (const id of fromIds) for (const c of shoreOf.get(id) ?? []) for (const n of nbr(c)) if (owner[n] === 0 && dist[n] < 0) { dist[n] = 0; prev[n] = -1; queue[tail++] = n; }
  while (head < tail) {
    const c = queue[head++];
    if (targets[c]) {
      const cells = [];
      for (let x = c; x >= 0; x = prev[x]) cells.push(x);
      return cells.reverse();
    }
    for (const n of nbr(c)) if (owner[n] === 0 && dist[n] < 0) { dist[n] = dist[c] + 1; prev[n] = c; queue[tail++] = n; }
  }
  return null;
}
const pathKm = (cells) => cells.reduce((a, c) => a + cellKm(c), 0) * Math.SQRT1_2 * 1.2; // diagonal-ish steps, roughly
const toPoints = (cells) => {
  const pts = [];
  for (let i = 0; i < cells.length; i++) if (i % KEEP_EVERY === 0 || i === cells.length - 1) pts.push([Math.round(((cells[i] % W) + 0.5) / SCALE * 10) / 10, Math.round((Math.floor(cells[i] / W) + 0.5) / SCALE * 10) / 10]);
  return pts;
};
const laneKey = (a, b) => [a, b].sort().join("|");

// ---- Nearest coasts by water, one sailing outward from each shore.
const shoreOwner = new Int32Array(W * H).fill(-1); // sea cell -> index of a region whose shore it touches (first wins)
for (const [id, cells] of shoreOf) {
  const idx = regionIndex.get(id);
  for (const c of cells) for (const n of nbr(c)) if (owner[n] === 0 && shoreOwner[n] < 0) shoreOwner[n] = idx;
}
function nearestByWater(fromId) {
  const me = regionIndex.get(fromId);
  const mine = byId.get(fromId);
  dist.fill(-1);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  for (const c of shoreOf.get(fromId)) for (const n of nbr(c)) if (owner[n] === 0 && dist[n] < 0) { dist[n] = 0; prev[n] = -1; queue[tail++] = n; }
  const found = [];
  const seen = new Set();
  while (head < tail && found.length < NEAR_COUNT) {
    const c = queue[head++];
    const o = shoreOwner[c];
    if (o >= 0 && o !== me) {
      const other = world.regions[o - 1].id;
      if (!seen.has(other) && !mine.neighbors.includes(other) && byId.get(other).coastal) {
        seen.add(other);
        const cells = [];
        for (let x = c; x >= 0; x = prev[x]) cells.push(x);
        cells.reverse();
        if (pathKm(cells) <= NEAR_WATER_KM) found.push({ other, cells });
      }
    }
    for (const n of nbr(c)) if (owner[n] === 0 && dist[n] < 0) { dist[n] = dist[c] + 1; prev[n] = c; queue[tail++] = n; if (dist[n] * 8 > NEAR_WATER_KM) tail--; }
  }
  return found;
}

const coastal = world.regions.filter((r) => r.coastal && (shoreOf.get(r.id)?.length ?? 0) > 0).sort((a, b) => a.id.localeCompare(b.id));
const landlocked = world.regions.filter((r) => r.coastal && !(shoreOf.get(r.id)?.length > 0)).map((r) => r.name);
const adj = new Map(coastal.map((r) => [r.id, new Set(r.seaRoutes.filter((s) => shoreOf.get(s)?.length))]));
const paths = {};
const dropped = [];
let kept = 0;
let addedByWater = 0;
for (const r of coastal) {
  for (const { other, cells } of nearestByWater(r.id)) {
    if (adj.get(r.id).has(other)) continue;
    adj.get(r.id).add(other);
    adj.get(other).add(r.id);
    paths[laneKey(r.id, other)] = { from: r.id, points: toPoints(cells), coasts: { [r.id]: coastAt(r.id, cells[0]), [other]: coastAt(other, cells[cells.length - 1]) } };
    addedByWater += 1;
  }
}
for (const r of coastal) for (const s of [...adj.get(r.id)]) {
  if (r.id > s) continue;
  if (paths[laneKey(r.id, s)]) { kept += 1; continue; }
  const cells = waterPath([r.id], [s]);
  const straight = km(r.id, s);
  if (!cells || pathKm(cells) > MAX_RATIO * straight) {
    adj.get(r.id).delete(s); adj.get(s).delete(r.id);
    dropped.push(`${r.name} - ${byId.get(s).name}${cells ? ` (${Math.round(pathKm(cells))} km by water vs ${Math.round(straight)})` : " (no water path)"}`);
    continue;
  }
  paths[laneKey(r.id, s)] = { from: r.id, points: toPoints(cells), coasts: { [r.id]: coastAt(r.id, cells[0]), [s]: coastAt(s, cells[cells.length - 1]) } };
  kept += 1;
}
// ---- Join the seas: from each piece, the nearest shore of another piece by water.
const pieces = () => {
  const comp = new Map();
  let n = 0;
  for (const r of coastal) {
    if (comp.has(r.id)) continue;
    n += 1;
    const q = [r.id];
    comp.set(r.id, n);
    while (q.length) { const x = q.shift(); for (const m of adj.get(x)) if (!comp.has(m)) { comp.set(m, n); q.push(m); } }
  }
  return { comp, n };
};
let { comp, n } = pieces();
const bridges = [];
let guard = 0;
while (n > 1 && guard++ < 50) {
  // The smallest piece reaches out.
  const sizes = new Map();
  for (const v of comp.values()) sizes.set(v, (sizes.get(v) ?? 0) + 1);
  const small = [...sizes.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0][0];
  const mine = coastal.filter((r) => comp.get(r.id) === small).map((r) => r.id);
  const others = coastal.filter((r) => comp.get(r.id) !== small).map((r) => r.id);
  const cells = waterPath(mine, others);
  if (!cells) { console.log(`piece of ${mine.length} (${mine.slice(0, 3).map((id) => byId.get(id).name).join(", ")}) has no water to any other shore`); break; }
  // Which shores did the path join? The land cells beside its two ends.
  const endA = nbr(cells[0]).find((c) => owner[c] && mine.includes(world.regions[owner[c] - 1].id));
  const endB = nbr(cells[cells.length - 1]).find((c) => owner[c] && others.includes(world.regions[owner[c] - 1].id));
  const a = world.regions[owner[endA] - 1].id, b = world.regions[owner[endB] - 1].id;
  adj.get(a).add(b); adj.get(b).add(a);
  paths[laneKey(a, b)] = { from: a, points: toPoints(cells), coasts: { [a]: coastAt(a, cells[0]), [b]: coastAt(b, cells[cells.length - 1]) } };
  bridges.push(`${byId.get(a).name} - ${byId.get(b).name} (${Math.round(pathKm(cells))} km by water)`);
  ({ comp, n } = pieces());
}
const after = [...adj.values()].reduce((s, v) => s + v.size, 0) / 2;
console.log(`grid ${W}x${H}; lanes by water added ${addedByWater}, kept ${kept}, dropped ${dropped.length}, bridges ${bridges.length}, now ${after}; pieces left: ${n}`);
if (landlocked.length) console.log(`coastal by data but with no shore on the grid (left alone): ${landlocked.join(", ")}`);
console.log("dropped: " + dropped.join("; "));
console.log("bridges: " + bridges.join("; "));
console.log(`coast segments: ${segments} over ${shoreOf.size} coasts`);
if (!DRY) {
  for (const r of world.regions) {
    if (!adj.has(r.id)) continue;
    r.seaRoutes = [...adj.get(r.id)].sort();
    r.laneCoasts = Object.fromEntries(r.seaRoutes.map((s) => [s, paths[laneKey(r.id, s)].coasts[r.id]]));
    delete r.laneBodies;
  }
  writeFileSync(WORLD, JSON.stringify(world));
  writeFileSync(OUT, JSON.stringify(paths));
  console.log(`wrote ${Object.keys(paths).length} water paths`);
}
