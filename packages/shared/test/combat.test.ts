import { describe, expect, it } from "vitest";
import { armySpeed, carryCapacity, resolveCombat } from "../src/rules/combat.js";
import { findRoute, travelSeconds } from "../src/rules/travel.js";
import { allRegions } from "../src/map/index.js";

describe("resolveCombat", () => {
  it("is deterministic for the same seed", () => {
    const a = resolveCombat({ units: { warrior: 20 }, bonus: 0 }, { units: { warrior: 10 }, bonus: 0 }, "seed-1");
    const b = resolveCombat({ units: { warrior: 20 }, bonus: 0 }, { units: { warrior: 10 }, bonus: 0 }, "seed-1");
    expect(a).toEqual(b);
  });

  it("lets a much larger force win with modest losses", () => {
    const r = resolveCombat({ units: { warrior: 50 }, bonus: 0 }, { units: { warrior: 5 }, bonus: 0 }, "x");
    expect(r.attackerWon).toBe(true);
    expect(r.defenderRemaining.warrior).toBe(0);
    expect(r.attackerLosses.warrior ?? 0).toBeLessThan(15);
  });

  it("walls help defenders", () => {
    const noWalls = resolveCombat({ units: { warrior: 15 }, bonus: 0 }, { units: { warrior: 10 }, bonus: 0 }, "w");
    const walls = resolveCombat({ units: { warrior: 15 }, bonus: 0 }, { units: { warrior: 10 }, bonus: 1.5 }, "w");
    expect((walls.attackerLosses.warrior ?? 0) >= (noWalls.attackerLosses.warrior ?? 0)).toBe(true);
    expect(walls.attackerWon).toBe(false);
  });

  it("attacking an empty region wins without a fight", () => {
    const r = resolveCombat({ units: { warrior: 3 }, bonus: 0 }, { units: {}, bonus: 0 }, "e");
    expect(r.attackerWon).toBe(true);
    expect(r.rounds).toBe(0);
  });

  it("computes carry and speed", () => {
    expect(carryCapacity({ warrior: 2, slinger: 1 })).toBe(40);
    expect(armySpeed({ warrior: 2, tracker: 1 })).toBe(5);
    expect(armySpeed({})).toBe(0);
  });
});

describe("findRoute", () => {
  it("finds a land route between neighbours and a longer one across a continent", () => {
    const [a] = allRegions().filter((r) => r.neighbors.length > 0);
    const n = a!.neighbors[0]!;
    const r = findRoute(a!.id, n, false)!;
    expect(r.path).toEqual([a!.id, n]);
    expect(r.cost).toBeGreaterThan(0);
    expect(travelSeconds(r, 5, 1)).toBeGreaterThan(600);
    expect(travelSeconds(r, 5, 10)).toBeLessThan(travelSeconds(r, 5, 1));
  });

  it("needs sea routes to cross water", () => {
    const uk = allRegions().find((r) => r.country === "gb");
    const fr = allRegions().find((r) => r.country === "fr");
    expect(uk && fr).toBeTruthy();
    const land = findRoute(uk!.id, fr!.id, false);
    const sea = findRoute(uk!.id, fr!.id, true);
    expect(sea).not.toBeNull();
    expect(sea!.usesSea).toBe(true);
    if (land) expect(land.cost).toBeGreaterThanOrEqual(sea!.cost);
  });
});
