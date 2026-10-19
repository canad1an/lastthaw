import { legIndex } from "../src/rules/travel.js";
import { describe, expect, it } from "vitest";
import { balance } from "../src/config/balance.js";
import { buildingById, techById, unitById } from "../src/config/ages.js";
import { formatCountdown, realSecondsToGameHours, scaledDuration, tickGapSeconds } from "../src/rules/time.js";
import { buildingCost, buildingSeconds, canAfford, dayCostMultiplier, missingFor, scaleCost, techCost, trainSeconds, unitCost } from "../src/rules/timers.js";
import { findRoute, laneKey, missionLabel, seaLegsOf, travelSeconds } from "../src/rules/travel.js";
import { armySpeed, bestHauler, breachOf, carryCapacity, haulerCount, splitNaval } from "../src/rules/combat.js";
import { loyaltyBand, loyaltyOutlook } from "../src/rules/loyalty.js";
import { seededRng } from "../src/rules/rng.js";
import { freezeDayForLatitude, iceLatitudeOnDay } from "../src/rules/ice.js";
import { allRegions, regionById } from "../src/map/index.js";

describe("time", () => {
  it("formats countdowns at every scale", () => {
    expect(formatCountdown(-5)).toBe("0s");
    expect(formatCountdown(59)).toBe("59s");
    expect(formatCountdown(61)).toBe("1m 1s");
    expect(formatCountdown(3600 + 120)).toBe("1h 2m");
    expect(formatCountdown(86400 * 2 + 3600 * 3 + 10)).toBe("2d 3h");
  });
  it("ticks more often in faster matches, down to a floor", () => {
    expect(tickGapSeconds(1)).toBe(balance.tick.minutes * 60);
    expect(tickGapSeconds(10)).toBe((balance.tick.minutes * 60) / 10);
    expect(tickGapSeconds(720)).toBe(balance.tick.minSeconds);
    expect(tickGapSeconds(0)).toBe(balance.tick.minutes * 60);
  });
  it("scales durations by match speed", () => {
    expect(scaledDuration(600, 1)).toBe(600);
    expect(scaledDuration(600, 10)).toBe(60);
    expect(realSecondsToGameHours(3600, 1)).toBeCloseTo(1);
    expect(realSecondsToGameHours(3600, 10)).toBeCloseTo(10);
  });
});

describe("costs and timers", () => {
  const huts = buildingById.get("huts")!;
  it("buildings cost more per level and later in the match", () => {
    const l1 = buildingCost(huts, 1);
    const l5 = buildingCost(huts, 5);
    for (const k of Object.keys(l1) as Array<keyof typeof l1>) expect(l5[k]!).toBeGreaterThan(l1[k]!);
    expect(dayCostMultiplier(0)).toBeLessThanOrEqual(dayCostMultiplier(20));
    const late = buildingCost(huts, 1, 20);
    expect(late.wood!).toBeGreaterThanOrEqual(l1.wood!);
    expect(buildingSeconds(huts, 2)).toBeGreaterThanOrEqual(buildingSeconds(huts, 1));
  });
  it("high levels grow steeper than low ones, so late building is the sink", () => {
    const t = balance.timers;
    const lowRatio = buildingCost(huts, 3).wood! / buildingCost(huts, 2).wood!;
    const highRatio = buildingCost(huts, t.lateLevel + 3).wood! / buildingCost(huts, t.lateLevel + 2).wood!;
    expect(highRatio).toBeGreaterThan(lowRatio);
    expect(highRatio).toBeCloseTo(t.costGrowth * t.lateCostGrowth, 1);
    const cheap = buildingById.get("storehouse") ?? huts;
    expect(buildingSeconds(cheap, t.lateLevel + 1) / buildingSeconds(cheap, t.lateLevel)).toBeCloseTo(Math.min(t.levelGrowth * t.lateTimeGrowth, t.maxSeconds / buildingSeconds(cheap, t.lateLevel)), 1);
  });
  it("units and techs scale the same way", () => {
    const w = unitById.get("warrior")!;
    expect(unitCost(w, 2).food ?? 0).toBeCloseTo(2 * (unitCost(w, 1).food ?? 0));
    expect(trainSeconds(w, 10)).toBeGreaterThan(trainSeconds(w, 1));
    const t = techById.get("fire_making")!;
    expect(techCost(t).food).toBe(t.cost.food);
    expect(scaleCost({ food: 10, wood: 4 }, 0.5)).toEqual({ food: 5, wood: 2 });
  });
  it("affordability and the shortfall list", () => {
    expect(canAfford({ food: 100, wood: 50 }, { food: 60, wood: 40 })).toBe(true);
    expect(canAfford({ food: 100, wood: 10 }, { food: 60, wood: 40 })).toBe(false);
    expect(missingFor({ food: 100, wood: 10 }, { food: 60, wood: 40, stone: 5 })).toEqual(["wood", "stone"]);
    expect(missingFor({ food: 100 }, {})).toEqual([]);
  });
});

describe("travel", () => {
  const start = allRegions().find((r) => r.neighbors.length >= 2)!;
  it("routes to a neighbour in one leg and to itself in none", () => {
    const next = start.neighbors[0]!;
    const r = findRoute(start.id, next, false)!;
    expect(r.path).toEqual([start.id, next]);
    expect(r.cost).toBeGreaterThan(0);
    expect(r.usesSea).toBe(false);
    expect(findRoute(start.id, start.id, false)?.path).toEqual([start.id]);
    expect(findRoute(start.id, "no-such-region", false)).toBeNull();
  });
  it("sea lanes only open with sea travel allowed", () => {
    const port = allRegions().find((r) => r.seaRoutes.length > 0 && r.neighbors.length === 0);
    if (!port) return;
    expect(findRoute(port.id, port.seaRoutes[0]!, false)).toBeNull();
    expect(findRoute(port.id, port.seaRoutes[0]!, true)?.usesSea).toBe(true);
  });
  it("roads shorten a leg between two road regions", () => {
    const next = start.neighbors[0]!;
    const plain = findRoute(start.id, next, false)!;
    const road = findRoute(start.id, next, false, new Set([start.id, next]))!;
    expect(road.cost).toBeLessThan(plain.cost);
    // A road on one end only helps part of the way: never worse than no road, never as good as both.
    const oneSided = findRoute(start.id, next, false, new Set([start.id]))!;
    expect(oneSided.cost).toBeLessThanOrEqual(plain.cost);
    expect(oneSided.cost).toBeGreaterThanOrEqual(road.cost);
  });
  it("travel time falls with speed and the match speed", () => {
    const r = findRoute(start.id, start.neighbors[0]!, false)!;
    // Seconds are rounded, so allow a few either way.
    expect(Math.abs(travelSeconds(r, 5, 1) - 2 * travelSeconds(r, 10, 1))).toBeLessThanOrEqual(2);
    expect(Math.abs(travelSeconds(r, 5, 1) - 10 * travelSeconds(r, 5, 10))).toBeLessThanOrEqual(10);
  });
  it("lanes and labels", () => {
    expect(laneKey("b", "a")).toBe(laneKey("a", "b"));
    expect(seaLegsOf([start.id, start.neighbors[0]!])).toEqual([]);
    expect(missionLabel("raid").toLowerCase()).toContain("raid");
    expect(missionLabel("expedition").length).toBeGreaterThan(0);
  });
});

describe("armies", () => {
  it("move at the pace of the slowest unit and carry what their haulers can", () => {
    const warrior = unitById.get("warrior")!;
    const caravan = unitById.get("caravan")!;
    expect(armySpeed({ warrior: 3 })).toBe(warrior.speed);
    expect(armySpeed({ warrior: 3, caravan: 1 })).toBe(Math.min(warrior.speed, caravan.speed));
    expect(armySpeed({})).toBe(0);
    expect(armySpeed({ warrior: 0 })).toBe(0);
    expect(carryCapacity({ caravan: 2 })).toBeCloseTo(2 * carryCapacity({ caravan: 1 }));
    expect(carryCapacity({ warrior: 5 })).toBeCloseTo(5 * warrior.carry);
    expect(haulerCount({ caravan: 2, warrior: 3 })).toBe(2);
    expect(bestHauler({ warrior: 3 })).toBeNull();
    expect(bestHauler({ caravan: 1 })).toBe("caravan");
  });
  it("siege engines breach, ships split from the land army", () => {
    expect(breachOf({ warrior: 10 })).toBe(0);
    const engine = [...unitById.values()].find((u) => (u.breach ?? 0) > 0);
    expect(engine).toBeTruthy();
    expect(breachOf({ [engine!.id]: 1 })).toBeGreaterThan(0);
    const ship = [...unitById.values()].find((u) => u.naval);
    expect(ship).toBeTruthy();
    const { ships, rest } = splitNaval({ warrior: 2, [ship!.id]: 1 });
    expect(ships).toEqual({ [ship!.id]: 1 });
    expect(rest).toEqual({ warrior: 2 });
  });
});

describe("loyalty", () => {
  it("bands follow the rebellion threshold", () => {
    expect(loyaltyBand(balance.conquest.rebelBelow - 0.01)).toBe("rebellious");
    expect(loyaltyBand(0.59)).toBe("uneasy");
    expect(loyaltyBand(1)).toBe("secure");
  });
  it("a region far from the capital has a lower target than one next door", () => {
    const cap = allRegions().find((r) => r.neighbors.length >= 2)!;
    const near = regionById(cap.neighbors[0]!)!;
    const far = allRegions().reduce((best, r) => (Math.abs(r.lat - cap.lat) + Math.abs(r.lon - cap.lon) > Math.abs(best.lat - cap.lat) + Math.abs(best.lon - cap.lon) ? r : best), near);
    const a = loyaltyOutlook(near.id, cap.id, 0, 100, 10, 0.5);
    const b = loyaltyOutlook(far.id, cap.id, 0, 100, 10, 0.5);
    expect(b.km).toBeGreaterThan(a.km);
    expect(b.target).toBeLessThanOrEqual(a.target);
    expect(loyaltyOutlook(near.id, cap.id, 0.3, 100, 10, 0.5).target).toBeGreaterThanOrEqual(a.target);
  });
});

describe("rng and ice", () => {
  it("seeded rng is deterministic and in [0, 1)", () => {
    const a = seededRng("seed:1");
    const b = seededRng("seed:1");
    const c = seededRng("seed:2");
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs).not.toEqual(Array.from({ length: 50 }, () => c()));
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it("the ice line only ever moves toward the equator, and freeze days invert it", () => {
    let prev = iceLatitudeOnDay(0);
    for (let d = 1; d <= balance.match.lengthDays; d++) {
      const lat = iceLatitudeOnDay(d);
      expect(lat).toBeLessThanOrEqual(prev);
      prev = lat;
    }
    expect(freezeDayForLatitude(89)).toBe(1);
    expect(freezeDayForLatitude(0)).toBeNull();
    for (const lat of [70, 60, 50, 40]) {
      const day = freezeDayForLatitude(lat);
      if (day === null) continue;
      expect(iceLatitudeOnDay(day)).toBeLessThanOrEqual(lat);
      expect(iceLatitudeOnDay(day - 1)).toBeGreaterThan(lat);
    }
    expect(balance.match.maxStartLatitude).toBeLessThan(iceLatitudeOnDay(1));
  });
});

describe("legs of a march", () => {
  it("tells which leg an army is on, and never past the last", () => {
    expect(legIndex(4, 0, 300, 0)).toBe(0);
    expect(legIndex(4, 0, 300, 100)).toBe(1);
    expect(legIndex(4, 0, 300, 210)).toBe(2);
    expect(legIndex(4, 0, 300, 999)).toBe(2);
    expect(legIndex(2, 0, 300, 150)).toBe(0);
    expect(legIndex(1, 0, 0, 5)).toBe(0);
  });
});
