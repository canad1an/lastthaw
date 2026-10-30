import { afterEach, describe, expect, it } from "vitest";
import { applyTechEffects, effectsOf, techEffectsOf } from "../src/rules/buildings.js";
import { computeRates, startingEconomy, type RegionTraits } from "../src/rules/settle.js";
import { setEconomyRulesResolver } from "../src/rules/economyRules.js";
import { balance } from "../src/config/balance.js";
import { TECHS } from "../src/config/ages.js";

const plains: RegionTraits = { terrain: "plains", resources: [], coastal: false, river: false };
// Every tech up to and including the one that enters the Industrial Age.
const industrial = TECHS.filter((t) => t.age <= 4 || t.advancesTo === 5).map((t) => t.id);

describe("economy rules", () => {
  afterEach(() => setEconomyRulesResolver(() => 1));

  it("rules 1: tech yields multiply building yields and people only eat the original ration", () => {
    const fx = applyTechEffects(effectsOf({ farm: 3 }), techEffectsOf(industrial));
    const t = techEffectsOf(industrial);
    expect(t.age).toBe(5);
    expect(fx.yield.food).toBeCloseTo(effectsOf({ farm: 3 }).yield.food * (1 + t.yield.food));
    expect(fx.needs).toEqual({ food: balance.economy.foodPerPersonPerHour, wood: 0, stone: 0 });
  });

  it("rules 2: tech yields add to building yields and every age entered adds to what a person uses", () => {
    setEconomyRulesResolver(() => 2);
    const t = techEffectsOf(industrial);
    const fx = applyTechEffects(effectsOf({ farm: 3 }), t);
    expect(fx.yield.food).toBeCloseTo(effectsOf({ farm: 3 }).yield.food + t.yield.food);
    const per = balance.economy.needsPerAge;
    expect(fx.needs.food).toBeCloseTo(balance.economy.foodPerPersonPerHour + per.food * 5);
    expect(fx.needs.wood).toBeCloseTo(per.wood * 5);
    expect(fx.needs.stone).toBeCloseTo(per.stone * 5);
    // A Stone Age tribe is unchanged.
    expect(applyTechEffects(effectsOf({}), techEffectsOf([])).needs).toEqual({ food: balance.economy.foodPerPersonPerHour, wood: 0, stone: 0 });
  });

  it("wood and stone a people uses come off the rates, and running out stops growth without killing anyone", () => {
    const base = { ...startingEconomy(), popWorkers: 100, capacity: 1000, assignment: { food: 1, wood: 0, stone: 0 }, needs: { food: 1.2, wood: 1, stone: 0.5 } };
    const r = computeRates(plains, base);
    expect(r.wood).toBeCloseTo(-100);
    expect(r.stone).toBeCloseTo(-50);
    expect(r.population).toBeGreaterThan(0);
    const out = computeRates(plains, { ...base, wood: 0 });
    expect(out.population).toBe(0);
    expect(out.starving).toBe(false);
  });

  it("soldiers eat several rations of the higher need", () => {
    const e = { ...startingEconomy(), popWorkers: 0, popSoldiers: 10, needs: { food: 6, wood: 0, stone: 0 } };
    const r = computeRates(plains, e);
    expect(r.gross.food - r.food).toBeCloseTo(10 * balance.economy.soldierFoodMultiplier * 6);
  });
});
