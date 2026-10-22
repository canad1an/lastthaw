/**
 * Where a region's buildings stand when the map is zoomed right in.
 *
 * Every region gets a centre (its pole of inaccessibility: the interior point farthest from the outline, where the
 * wonder stands) and up to SLOTS interior points for the other buildings, packed as a town round the centre: the
 * nearest interior cells first, each at least GAP map units from every other (the gap halves until a small region
 * fits at least MIN_SLOTS). Cells within EDGE cells of the outline, within CLEAR map units of the centre and within
 * CLEAR of the harbour's coast point are left empty, so pictures do not straddle a border or sit on the name badge
 * or the quay. Each region also records its bounding box, so the map can skip towns out of view, and the
 * spacing of its slots, so pictures shrink to fit a small province.
 *
 * Deterministic. Run: node tools/mapgen/src/town-slots.mjs
 * Writes apps/web/src/map/townSlots.json: { [regionId]: { c: [x, y], r: spacing, b: [x0, y0, x1, y1], s: [[x, y], ...] } }
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neighbours, rasterise, rings } from "./grid.mjs";

const SCALE = 4; // cells per map unit: 8000 x 4000
const SLOTS = 26; // enough for every town building a region can have (the test checks)
const MIN_SLOTS = 4;
const EDGE = 3; // cells kept clear inside the outline
const CLEAR = 1.6; // map units kept clear round the centre and the coast point
const STEP = 2; // candidate cells every n-th cell each way
const GAP = 2.4; // map units between neighbouring buildings (a picture is 2.2 wide)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const world = JSON.parse(readFileSync(path.join(ROOT, "packages", "shared", "src", "map", "world.json"), "utf8"));
const coast = JSON.parse(readFileSync(path.join(ROOT, "apps", "web", "src", "map", "coastPoints.json"), "utf8"));
const OUT = path.join(ROOT, "apps", "web", "src", "map", "townSlots.json");

const { owner, W, H } = rasterise(world, SCALE);
const toMap = (c) => [((c % W) + 0.5) / SCALE, (Math.floor(c / W) + 0.5) / SCALE];

// Cells of each region, and each cell's distance (in cells, Chebyshev) to the outline by a multi-source BFS.
const cellsOf = new Map();
for (let c = 0; c < owner.length; c++) {
  if (!owner[c]) continue;
  const id = world.regions[owner[c] - 1].id;
  let list = cellsOf.get(id);
  if (!list) cellsOf.set(id, (list = []));
  list.push(c);
}
const depth = new Int32Array(owner.length).fill(-1);
{
  const queue = new Int32Array(owner.length);
  let head = 0, tail = 0;
  for (let c = 0; c < owner.length; c++) {
    if (!owner[c]) continue;
    if (neighbours(c, W, H).some((n) => owner[n] !== owner[c])) { depth[c] = 0; queue[tail++] = c; }
  }
  while (head < tail) {
    const c = queue[head++];
    for (const n of neighbours(c, W, H)) if (owner[n] === owner[c] && depth[n] < 0) { depth[n] = depth[c] + 1; queue[tail++] = n; }
  }
}

const out = {};
let short = 0;
for (const r of world.regions) {
  const cells = cellsOf.get(r.id) ?? [];
  if (cells.length === 0) { console.warn(`${r.name}: no cells on the grid`); continue; }
  // Bounding box from the outline itself.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings(r.path)) for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  // Centre: the deepest cell, ties to the one nearest the region's labelled point.
  let centre = cells[0];
  for (const c of cells) {
    if (depth[c] > depth[centre]) centre = c;
    else if (depth[c] === depth[centre]) {
      const [ax, ay] = toMap(c), [bx, by] = toMap(centre);
      if (Math.hypot(ax - r.x, ay - r.y) < Math.hypot(bx - r.x, by - r.y)) centre = c;
    }
  }
  const [cx, cy] = toMap(centre);
  const quay = coast[r.id];
  // Candidates: interior cells on a coarse lattice, clear of the edge, the centre and the quay.
  let candidates = [];
  for (const c of cells) {
    const x = c % W, y = Math.floor(c / W);
    if (x % STEP || y % STEP || depth[c] < EDGE) continue;
    const [mx, my] = toMap(c);
    if (Math.hypot(mx - cx, my - cy) < CLEAR) continue;
    if (quay && Math.hypot(mx - quay.x, my - quay.y) < CLEAR) continue;
    candidates.push([mx, my]);
  }
  if (candidates.length < MIN_SLOTS) {
    // A tiny region: take any interior cell except the centre itself.
    candidates = cells.filter((c) => c !== centre && depth[c] >= 1).map(toMap);
  }
  // The town: candidates by distance from the centre, each kept only if it clears every building placed before it.
  // A region too small for MIN_SLOTS at the full gap gets a tighter one.
  candidates.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy) || p[1] - q[1] || p[0] - q[0]);
  let picked = [];
  let gap = GAP;
  for (;;) {
    picked = [];
    const placed = [[cx, cy]];
    for (let i = 0; i < candidates.length && picked.length < SLOTS; i++) {
      const [x, y] = candidates[i];
      if (placed.every(([px, py]) => Math.hypot(x - px, y - py) >= gap)) { picked.push(i); placed.push([x, y]); }
    }
    if (picked.length >= Math.min(MIN_SLOTS, candidates.length) || gap <= 0.4) break;
    gap /= 2;
  }
  const s = picked.map((i) => candidates[i].map((v) => Math.round(v * 10) / 10));
  // Spacing: the smallest gap between any two placed points (slots and centre); pictures are sized from it.
  let spacing = Infinity;
  const pts = [[cx, cy], ...s];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) spacing = Math.min(spacing, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
  if (!Number.isFinite(spacing)) spacing = Math.min(x1 - x0, y1 - y0) / 2;
  if (s.length < MIN_SLOTS) short += 1;
  out[r.id] = {
    c: [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10],
    r: Math.round(spacing * 100) / 100,
    b: [x0, y0, x1, y1].map((v) => Math.round(v * 10) / 10),
    s,
  };
}
writeFileSync(OUT, JSON.stringify(out));
const counts = Object.values(out).map((t) => t.s.length);
console.log(`town slots for ${counts.length} regions: ${counts.filter((n) => n >= SLOTS).length} full, ${short} under ${MIN_SLOTS}; smallest spacing ${Math.min(...Object.values(out).map((t) => t.r)).toFixed(2)}`);
