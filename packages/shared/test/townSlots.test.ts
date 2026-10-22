import { describe, expect, it } from "vitest";
import { BUILDINGS } from "../src/config/ages.js";
import { world } from "../src/map/index.js";
import { pathRings, pointInRings } from "../src/map/svgPath.js";
import { WALL_ORDER } from "../src/rules/buildings.js";
import townSlots from "../../../apps/web/src/map/townSlots.json" with { type: "json" };

type Slot = { c: [number, number]; r: number; b: [number, number, number, number]; s: [number, number][] };
const slots = townSlots as unknown as Record<string, Slot>;

/** The town slots (tools/mapgen/src/town-slots.mjs) must put every building inside its own region. */
describe("town slots", () => {
  it("gives every region a centre and slots inside its outline", () => {
    for (const r of world.regions) {
      const t = slots[r.id];
      expect(t, `${r.name} has no town slots`).toBeDefined();
      const rings = pathRings(r.path);
      expect(pointInRings(rings, t!.c[0], t!.c[1]), `${r.name}: centre outside`).toBe(true);
      expect(t!.s.length, `${r.name}: too few slots`).toBeGreaterThanOrEqual(4);
      for (const [x, y] of t!.s) expect(pointInRings(rings, x, y), `${r.name}: slot ${x},${y} outside`).toBe(true);
      const [x0, y0, x1, y1] = t!.b;
      for (const [x, y] of [t!.c, ...t!.s]) {
        expect(x).toBeGreaterThanOrEqual(x0);
        expect(x).toBeLessThanOrEqual(x1);
        expect(y).toBeGreaterThanOrEqual(y0);
        expect(y).toBeLessThanOrEqual(y1);
      }
      expect(t!.r).toBeGreaterThan(0);
    }
  });

  it("has room for every town building", () => {
    // Walls are the region's ring, the harbour stands on the quay, roads and rails are links, the wonder takes the centre.
    const elsewhere = new Set<string>([...WALL_ORDER, "harbor", "roads", "railway", "great_hearth"]);
    const town = BUILDINGS.filter((b) => !elsewhere.has(b.id));
    const most = Math.max(...Object.values(slots).map((t) => t.s.length));
    expect(town.length, "more town buildings than slots: raise SLOTS in town-slots.mjs").toBeLessThanOrEqual(most);
  });
});
