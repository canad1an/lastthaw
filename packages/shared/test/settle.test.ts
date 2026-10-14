import { describe, expect, it } from "vitest";
import { computeRates, settle, startingEconomy, type RegionTraits } from "../src/rules/settle.js";

const plains: RegionTraits = { terrain: "plains", resources: ["fertile_soil"], coastal: false, river: true };

describe("settle", () => {
  it("is a no-op for zero or negative time", () => {
    const s = startingEconomy();
    expect(settle(plains, s, 0, 1)).toEqual(s);
    expect(settle(plains, s, -10, 1)).toEqual(s);
  });

  it("is path independent: settle(t1) then settle(t2) equals settle(t1+t2)", () => {
    const s = startingEconomy();
    const a = settle(plains, settle(plains, s, 3600, 1), 7200, 1);
    const b = settle(plains, s, 10800, 1);
    for (const k of ["food", "wood", "stone", "popWorkers"] as const) {
      expect(a[k]).toBeCloseTo(b[k], 3);
    }
  });

  it("produces at speed 10 what it would in ten times the real time at speed 1", () => {
    const s = startingEconomy();
    const fast = settle(plains, s, 600, 10);
    const slow = settle(plains, s, 6000, 1);
    expect(fast.food).toBeCloseTo(slow.food, 3);
    expect(fast.popWorkers).toBeCloseTo(slow.popWorkers, 3);
  });

  it("grows population and gathers resources on fertile plains", () => {
    const s = startingEconomy();
    const after = settle(plains, s, 24 * 3600, 1);
    expect(after.popWorkers).toBeGreaterThan(s.popWorkers);
    expect(after.food).toBeGreaterThan(s.food);
    expect(after.wood).toBeGreaterThan(s.wood);
  });

  it("stops at storage caps", () => {
    const s = startingEconomy();
    const after = settle(plains, s, 30 * 24 * 3600, 1);
    expect(after.food).toBeLessThanOrEqual(s.storage.food);
    expect(after.wood).toBeLessThanOrEqual(s.storage.wood);
    expect(after.stone).toBeLessThanOrEqual(s.storage.stone);
  });

  it("starves when nobody gathers food", () => {
    const s = { ...startingEconomy(), food: 0, assignment: { food: 0, wood: 1, stone: 0 } };
    const r = computeRates(plains, s);
    expect(r.starving).toBe(true);
    const after = settle(plains, s, 24 * 3600, 1);
    expect(after.popWorkers).toBeLessThan(s.popWorkers);
  });

  it("produces nothing when frozen and population declines", () => {
    const s = { ...startingEconomy(), frozen: true };
    const after = settle(plains, s, 24 * 3600, 1);
    expect(after.wood).toBe(s.wood);
    expect(after.popWorkers).toBeLessThan(s.popWorkers);
  });
});
