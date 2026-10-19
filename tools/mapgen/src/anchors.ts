/**
 * Drawing anchors. A region's lat/lon is its spherical centroid and the game uses it as such (the ice freezes by latitude).
 * Its x/y is where the map draws its marker, its route waypoint and its label, and the centroid of a crescent, a horseshoe
 * or an archipelago lands outside the region, so a route to it appears to end next door. This pass moves x/y of every
 * such region to a point inside its largest ring. Runs after generate.ts and on the checked-in world.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type Point = [number, number];

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, "../../../packages/shared/src/map/world.json");

/** The rings of an SVG path made of M/L/Z commands with absolute coordinates. */
export function rings(d: string): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] = [];
  const re = /([MLZ])([^MLZ]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1] === "M" && cur.length) {
      out.push(cur);
      cur = [];
    }
    if (m[1] === "Z") {
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    const nums = m[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) cur.push([nums[i]!, nums[i + 1]!]);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function inRing(p: Point, ring: Point[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Inside any ring of the path (holes are not drawn separately here; a point in a hole is as good as outside for the eye). */
export function inPath(p: Point, d: string): boolean {
  return rings(d).some((r) => inRing(p, r));
}

function area(ring: Point[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j]![0] + ring[i]![0]) * (ring[j]![1] - ring[i]![1]);
  return Math.abs(a / 2);
}

function centroid(ring: Point[]): Point {
  let x = 0;
  let y = 0;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
    x += (ring[j]![0] + ring[i]![0]) * f;
    y += (ring[j]![1] + ring[i]![1]) * f;
    a += f;
  }
  if (a === 0) return ring[0]!;
  return [x / (3 * a), y / (3 * a)];
}

/** The midpoint of the longest horizontal span inside the ring at height y, or null if the line misses it. */
function widestSpanAt(ring: Point[], y: number): Point | null {
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  let best: Point | null = null;
  let bestLen = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const len = xs[i + 1]! - xs[i]!;
    if (len > bestLen) {
      bestLen = len;
      best = [(xs[i]! + xs[i + 1]!) / 2, y];
    }
  }
  return best;
}

/** A point inside the largest ring: its centroid when that is inside, else the widest span on a few scanlines through it. */
export function anchorOf(d: string): Point | null {
  const rs = rings(d).filter((r) => r.length >= 3);
  if (!rs.length) return null;
  const ring = rs.reduce((a, b) => (area(b) > area(a) ? b : a));
  const c = centroid(ring);
  if (inRing(c, ring)) return c;
  const ys = ring.map((p) => p[1]);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  let best: Point | null = null;
  let bestLen = 0;
  // The centroid's height first, then a sweep: the widest span wins.
  for (const y of [c[1], ...Array.from({ length: 9 }, (_, i) => minY + ((i + 1) * (maxY - minY)) / 10)]) {
    const s = widestSpanAt(ring, y);
    if (!s) continue;
    const xs = ring.filter((p) => Math.abs(p[1] - y) < 1e-9).length; // vertices on the line make the span count unreliable; skip those heights
    if (xs) continue;
    const len = spanLength(ring, y);
    if (len > bestLen) {
      bestLen = len;
      best = s;
    }
  }
  return best;
}

function spanLength(ring: Point[], y: number): number {
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
  }
  xs.sort((a, b) => a - b);
  let best = 0;
  for (let i = 0; i + 1 < xs.length; i += 2) best = Math.max(best, xs[i + 1]! - xs[i]!);
  return best;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const world = JSON.parse(readFileSync(file, "utf8")) as { regions: Array<{ id: string; name: string; x: number; y: number; path: string }> };
  let moved = 0;
  for (const r of world.regions) {
    if (inPath([r.x, r.y], r.path)) continue;
    const a = anchorOf(r.path);
    if (!a || !inPath(a, r.path)) {
      console.log(`no anchor found for ${r.name}`);
      continue;
    }
    console.log(`${r.name}: (${r.x}, ${r.y}) -> (${a[0].toFixed(1)}, ${a[1].toFixed(1)})`);
    r.x = +a[0].toFixed(1);
    r.y = +a[1].toFixed(1);
    moved += 1;
  }
  writeFileSync(file, JSON.stringify(world));
  console.log(`${moved} anchors moved inside their regions`);
}
