import { describe, expect, it } from "vitest";
import { validateWorld, type WorldMap } from "../src/map/index.js";
import pangaeaJson from "../src/map/pangaea.json" with { type: "json" };

const pangaea = pangaeaJson as unknown as WorldMap;

/** The Pangaea map (tools/mapgen/src/generate-pangaea.ts) must be as sound as Earth's. */
describe("pangaea map", () => {
  it("validates structurally", () => {
    expect(() => validateWorld(pangaea)).not.toThrow();
  });

  it("has roughly 400 regions, all with their own ids, on one landmass", () => {
    expect(pangaea.regions.length).toBeGreaterThanOrEqual(360);
    expect(pangaea.regions.length).toBeLessThanOrEqual(460);
    for (const r of pangaea.regions) {
      expect(r.id.startsWith("pg-"), `${r.id} is namespaced`).toBe(true);
      expect(r.resources.length).toBeGreaterThanOrEqual(1);
      expect(r.resources.length).toBeLessThanOrEqual(2);
      expect(Math.abs(r.lat)).toBeLessThanOrEqual(90);
      expect(r.path.startsWith("M")).toBe(true);
    }
    // One supercontinent: a walk by land from any region reaches most of the map.
    const byId = new Map(pangaea.regions.map((r) => [r.id, r]));
    const seen = new Set<string>();
    const queue = [pangaea.regions[0]!.id];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const n of byId.get(id)!.neighbors) queue.push(n);
    }
    expect(seen.size).toBeGreaterThan(pangaea.regions.length * 0.6);
  });

  it("keeps a fair share of land in the temperate band where matches start", () => {
    const starts = pangaea.regions.filter((r) => Math.abs(r.lat) <= 40 && r.terrain !== "tundra" && r.terrain !== "desert");
    expect(starts.length).toBeGreaterThan(120);
  });
});
