/**
 * Densify the sea lanes in world.json so that the coasts form one connected sea.
 *
 * The generator gave each coastal region its two nearest sea routes within 2,500 km, which left the sea in four
 * separate pieces (the Indian Ocean coast of Africa could not reach the Atlantic, for one). Ships now sail lane to lane,
 * so every coast must be reachable from every other. This pass keeps every existing lane and adds:
 *   1. for each coastal region, lanes to its nearest coastal non-neighbours within NEAR_KM until it has at least
 *      NEAR_COUNT lanes (coast-following hops a canoe can chain);
 *   2. the shortest lane between any two remaining pieces, until there is one piece.
 * Deterministic: the same input gives the same output. Run with: node tools/mapgen/src/dense-lanes.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NEAR_KM = 1200;
const NEAR_COUNT = 4;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAP = process.argv.find((a) => a.startsWith("--map="))?.slice(6) ?? "earth";
const WORLD = path.join(ROOT, "packages", "shared", "src", "map", MAP === "earth" ? "world.json" : `${MAP}.json`);
const world = JSON.parse(readFileSync(WORLD, "utf8"));
const byId = new Map(world.regions.map((r) => [r.id, r]));
const rad = (x) => (x * Math.PI) / 180;
const km = (a, b) => {
  const A = byId.get(a);
  const B = byId.get(b);
  return 2 * 6371 * Math.asin(Math.sqrt(Math.sin(rad(B.lat - A.lat) / 2) ** 2 + Math.cos(rad(A.lat)) * Math.cos(rad(B.lat)) * Math.sin(rad(B.lon - A.lon) / 2) ** 2));
};
const coastal = world.regions.filter((r) => r.coastal).sort((a, b) => a.id.localeCompare(b.id));
const adj = new Map(coastal.map((r) => [r.id, new Set(r.seaRoutes)]));
const before = [...adj.values()].reduce((a, s) => a + s.size, 0) / 2;
let added = 0;
const link = (a, b) => {
  if (adj.get(a).has(b)) return;
  adj.get(a).add(b);
  adj.get(b).add(a);
  added += 1;
};
for (const r of coastal) {
  const near = coastal
    .filter((o) => o !== r && !r.neighbors.includes(o.id))
    .map((o) => [o.id, km(r.id, o.id)])
    .filter(([, d]) => d <= NEAR_KM)
    .sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]));
  for (const [id] of near) {
    if (adj.get(r.id).size >= NEAR_COUNT) break;
    link(r.id, id);
  }
}
const pieces = () => {
  const comp = new Map();
  let n = 0;
  for (const r of coastal) {
    if (comp.has(r.id)) continue;
    n += 1;
    const q = [r.id];
    comp.set(r.id, n);
    while (q.length) {
      const x = q.shift();
      for (const m of adj.get(x)) if (!comp.has(m)) { comp.set(m, n); q.push(m); }
    }
  }
  return { comp, n };
};
let { comp, n } = pieces();
const bridges = [];
while (n > 1) {
  let best = null;
  for (const a of coastal) for (const b of coastal) {
    if (comp.get(a.id) === comp.get(b.id)) continue;
    const d = km(a.id, b.id);
    if (!best || d < best[2] || (d === best[2] && (a.id + b.id).localeCompare(best[0] + best[1]) < 0)) best = [a.id, b.id, d];
  }
  link(best[0], best[1]);
  bridges.push(`${byId.get(best[0]).name} - ${byId.get(best[1]).name} (${Math.round(best[2])} km)`);
  ({ comp, n } = pieces());
}
for (const r of coastal) r.seaRoutes = [...adj.get(r.id)].sort();
writeFileSync(WORLD, JSON.stringify(world));
console.log(`lanes ${before} -> ${before + added} (+${added}); bridges: ${bridges.join("; ") || "none"}; the sea is one piece`);
