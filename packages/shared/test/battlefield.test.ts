import { describe, expect, it } from "vitest";
import { FIELD_MAX_FIGURES, castBattlefield, closeRanks, figureLook } from "../src/rules/battlefield.js";

const attacker = { spearman: 6, warrior: 10, cavalry: 4, archer: 6, catapult: 2 };
const defender = { swordsman: 5, spearman: 8, militia: 4, archer: 5 };
const log = [
  { round: 1, aLoss: { warrior: 1 }, dLoss: { spearman: 1, militia: 1 } },
  { round: 2, aLoss: { warrior: 1, archer: 1 }, dLoss: { spearman: 1 } },
  { round: 3, aLoss: {}, dLoss: { swordsman: 2 } },
];

describe("battlefield cast", () => {
  it("draws one figure per unit, front line first and siege behind", () => {
    const f = castBattlefield("b1", attacker, defender, []);
    expect(f.k).toBe(1);
    expect(f.figures.filter((x) => x.side === 0)).toHaveLength(28);
    expect(f.figures.filter((x) => x.side === 1)).toHaveLength(22);
    const a = f.figures.filter((x) => x.side === 0);
    const front = Math.min(...a.filter((x) => x.look.cat === "foot").map((x) => x.col0));
    const archers = Math.min(...a.filter((x) => x.unit === "archer").map((x) => x.col0));
    const siege = Math.min(...a.filter((x) => x.look.cat === "siege").map((x) => x.col0));
    expect(front).toBe(0);
    expect(archers).toBeGreaterThan(front);
    expect(siege).toBeGreaterThan(Math.max(...a.filter((x) => x.look.cat !== "siege").map((x) => x.col0)));
    expect(f.figures.every((x) => x.fallRound === null)).toBe(true);
  });

  it("fells exactly the logged losses, the same figures for every viewer whenever they open it", () => {
    const later = castBattlefield("b1", attacker, defender, log);
    const fallen = later.figures.filter((x) => x.fallRound !== null);
    expect(fallen).toHaveLength(8);
    expect(fallen.filter((x) => x.side === 1 && x.unit === "swordsman" && x.fallRound === 3)).toHaveLength(2);
    // Watching from round one, the falls of the first two rounds are the same figures as for someone opening at round three.
    const early = castBattlefield("b1", attacker, defender, log.slice(0, 2));
    for (const x of early.figures.filter((y) => y.fallRound !== null)) expect(later.figures[x.n]!.fallRound).toBe(x.fallRound);
    expect(castBattlefield("b1", attacker, defender, log)).toEqual(later);
    expect(castBattlefield("b2", attacker, defender, log)).not.toEqual(later);
  });

  it("takes melee losses from the front and closes the ranks behind them", () => {
    const f = castBattlefield("b3", attacker, defender, [{ round: 1, aLoss: {}, dLoss: { swordsman: 1 } }]);
    const dead = f.figures.find((x) => x.fallRound === 1)!;
    expect(dead.col0).toBe(0);
    const cols = closeRanks(f.figures, 1, (x) => x.fallRound === null);
    const sameFile = f.figures.filter((x) => x.side === 1 && x.file === dead.file && x.fallRound === null);
    expect(Math.min(...sameFile.map((x) => cols.get(x.n)!))).toBe(0);
  });

  it("lets one figure stand for several men in a big fight", () => {
    const big = castBattlefield("b4", { warrior: 100, archer: 60 }, { spearman: 120 }, [{ round: 1, aLoss: { warrior: 4 }, dLoss: { spearman: 3 } }]);
    expect(big.k).toBe(Math.ceil(160 / FIELD_MAX_FIGURES));
    expect(big.figures.filter((x) => x.side === 0)).toHaveLength(Math.ceil(100 / big.k) + Math.ceil(60 / big.k));
    // 100 warriors to 96 at three a figure: 34 figures to 32.
    expect(big.figures.filter((x) => x.side === 0 && x.fallRound === 1)).toHaveLength(2);
    expect(big.figures.filter((x) => x.side === 1 && x.fallRound === 1)).toHaveLength(1);
  });

  it("knows how to draw every kind of soldier", () => {
    expect(figureLook("cavalry").cat).toBe("horse");
    expect(figureLook("archer").cat).toBe("ranged");
    expect(figureLook("catapult").cat).toBe("siege");
    expect(figureLook("settler").cat).toBe("civil");
    expect(figureLook("no_such_unit").cat).toBe("foot");
  });
});
