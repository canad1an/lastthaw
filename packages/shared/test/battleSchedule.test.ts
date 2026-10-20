import { describe, expect, it } from "vitest";
import { balance, battleSchedule } from "../src/index.js";

const total = (u: Record<string, number>) => Object.values(u).reduce((a, b) => a + b, 0);

describe("battle playback schedule", () => {
  it("removes one unit a round, sums exactly to the losses, interleaves both sides and is deterministic", () => {
    const a = { warrior: 7, archer: 3 };
    const d = { warrior: 4, militia: 6 };
    const rounds = battleSchedule(a, d, "seed-1");
    expect(rounds.length).toBe(20);
    const sumA: Record<string, number> = {};
    const sumD: Record<string, number> = {};
    let aRounds = 0;
    let dRounds = 0;
    for (const [la, ld] of rounds) {
      expect(total(la) + total(ld)).toBe(1);
      for (const [k, v] of Object.entries(la)) sumA[k] = (sumA[k] ?? 0) + v;
      for (const [k, v] of Object.entries(ld)) sumD[k] = (sumD[k] ?? 0) + v;
      if (total(la)) aRounds += 1;
      else dRounds += 1;
    }
    expect(sumA).toEqual(a);
    expect(sumD).toEqual(d);
    expect(aRounds).toBe(10);
    expect(dRounds).toBe(10);
    // Both sides fall throughout, not one side first.
    expect(rounds.slice(0, 10).some(([la]) => total(la) > 0)).toBe(true);
    expect(rounds.slice(0, 10).some(([, ld]) => total(ld) > 0)).toBe(true);
    expect(battleSchedule(a, d, "seed-1")).toEqual(rounds);
    expect(battleSchedule(a, d, "seed-2")).not.toEqual(rounds);
  });

  it("goes to two a round for a big fight and caps the rounds for an enormous one", () => {
    const max = balance.battle.maxRounds;
    const big = battleSchedule({ warrior: max }, { warrior: 20 }, "s");
    expect(big.length).toBe(Math.ceil((max + 20) / 2));
    expect(big.every(([la, ld]) => total(la) + total(ld) <= 2)).toBe(true);
    const huge = battleSchedule({ warrior: 900 }, { militia: 600 }, "s");
    expect(huge.length).toBeLessThanOrEqual(max);
    expect(huge.reduce((n, [la, ld]) => n + total(la) + total(ld), 0)).toBe(1500);
  });

  it("is empty when nobody fell", () => {
    expect(battleSchedule({}, {}, "s")).toEqual([]);
  });
});
