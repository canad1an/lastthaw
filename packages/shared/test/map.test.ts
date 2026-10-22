import { describe, expect, it } from "vitest";
import {
  allRegions,
  distanceKm,
  neighborsOf,
  regionById,
  validateWorld,
  earth as world,
} from "../src/map/index.js";

/**
 * world.json is written by tools/mapgen as one region per line, so its size on
 * disk is exactly the compact JSON plus one newline per region plus two.
 */
function worldJsonBytes(): number {
  return new TextEncoder().encode(JSON.stringify(world)).length + world.regions.length + 2;
}

describe("world map", () => {
  it("validates structurally", () => {
    expect(() => validateWorld(world)).not.toThrow();
  });

  it("has roughly 400 regions", () => {
    expect(world.regions.length).toBeGreaterThanOrEqual(380);
    expect(world.regions.length).toBeLessThanOrEqual(420);
  });

  it("gives every region 1-2 resources, no duplicates", () => {
    for (const r of world.regions) {
      expect(r.resources.length).toBeGreaterThanOrEqual(1);
      expect(r.resources.length).toBeLessThanOrEqual(2);
      expect(new Set(r.resources).size).toBe(r.resources.length);
    }
  });

  it("has at least 50 coastal regions", () => {
    expect(world.regions.filter((r) => r.coastal).length).toBeGreaterThanOrEqual(50);
  });

  it("stays under 1,000,000 bytes", () => {
    expect(worldJsonBytes()).toBeLessThan(1_000_000);
    expect(world.version).toBe(1);
  });

  it("contains well-known countries", () => {
    const countries = new Set(world.regions.map((r) => r.country));
    for (const c of ["fr", "us", "cn", "in", "br", "ru", "au", "eg"]) {
      expect(countries.has(c), `missing country ${c}`).toBe(true);
    }
  });

  it("has a valid projection and centroids", () => {
    for (const r of world.regions) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x).toBeLessThanOrEqual(2000);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeLessThanOrEqual(1000);
      expect(r.path.startsWith("M")).toBe(true);
      expect(r.value).toBeGreaterThan(0);
    }
  });

  it("draws every region's point inside its own shape, so routes and markers land on the right region", () => {
    // Salamat's centroid used to land in Batha, so a route to it ended next door. The anchor pass in tools/mapgen fixes such regions.
    type Point = [number, number];
    const rings = (d: string): Point[][] => {
      const out: Point[][] = [];
      let cur: Point[] = [];
      for (const m of d.matchAll(/([MLZ])([^MLZ]*)/g)) {
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
    };
    const inRing = (p: Point, ring: Point[]) => {
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!;
        const [xj, yj] = ring[j]!;
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const outside = world.regions.filter((r) => !rings(r.path).some((ring) => inRing([r.x, r.y], ring))).map((r) => r.name);
    expect(outside).toEqual([]);
  });

  it("exposes helpers", () => {
    const first = allRegions()[0]!;
    expect(regionById(first.id)).toBe(first);
    expect(regionById("nope-nowhere")).toBeUndefined();
    const links = neighborsOf(first.id);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.via === "land" || l.via === "sea")).toBe(true);
    const other = links[0]!.region;
    expect(distanceKm(first, other)).toBeGreaterThan(0);
    expect(distanceKm(first.id, first.id)).toBe(0);
  });
});
