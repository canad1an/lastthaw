/**
 * Post-processing for world.json: derive each region's northern and southern
 * latitude extent from its projected SVG path, so the ice can taper across a
 * region instead of freezing it all at once at its centre.
 * Run: npx tsx tools/mapgen/src/extents.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, "../../../packages/shared/src/map/world.json");
const world = JSON.parse(readFileSync(file, "utf8")) as { height: number; regions: Array<Record<string, unknown> & { path: string; lat: number }> };

let changed = 0;
for (const r of world.regions) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const m of r.path.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)) {
    const y = Number(m[2]);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minY)) continue;
  const latNorth = Math.round((90 - (minY / world.height) * 180) * 100) / 100;
  const latSouth = Math.round((90 - (maxY / world.height) * 180) * 100) / 100;
  if (r.latNorth !== latNorth || r.latSouth !== latSouth) {
    r.latNorth = latNorth;
    r.latSouth = latSouth;
    changed += 1;
  }
}
writeFileSync(file, JSON.stringify(world));
console.log(`extents written for ${world.regions.length} regions (${changed} changed)`);
