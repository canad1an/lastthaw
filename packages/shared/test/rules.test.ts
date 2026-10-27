import { legIndex } from "../src/rules/travel.js";
import { reachableLevel, levelName } from "../src/rules/buildings.js";
import { describe, expect, it } from "vitest";
import { balance } from "../src/config/balance.js";
import { buildingById, techById, unitById } from "../src/config/ages.js";
import { formatCountdown, realSecondsToGameHours, scaledDuration, tickGapSeconds } from "../src/rules/time.js";
import { buildingCost, buildingSeconds, canAfford, dayCostMultiplier, missingFor, scaleCost, techCost, trainSeconds, unitCost } from "../src/rules/timers.js";
import { findRoute, laneKey, missionLabel, paceFor, seaLegsOf, travelSeconds } from "../src/rules/travel.js";
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
  it("Roads level 2 is the Railway: its own price and time, and out of reach without Railways", () => {
    const roads = buildingById.get("roads")!;
    expect(reachableLevel(roads, new Set())).toBe(1);
    expect(reachableLevel(roads, new Set(["railways"]))).toBe(2);
    expect(levelName(roads, 2)).toBe("Railway");
    expect(levelName(roads, 1)).toBeNull();
    // Priced on the Railway's own cost, per neighbour, not on the level curve.
    { const { levelCost: _lc, ...plain } = roads; void _lc; expect(buildingCost(roads, 2, 0, 3)).toEqual(buildingCost({ ...plain, cost: roads.levelCost![2]! }, 1, 0, 3)); }
    expect(buildingSeconds(roads, 2)).toBe(roads.levelSeconds![2]);
  });
  it("trains run at full speed on track and as a freight wagon off it, and take the quickest way", () => {
    const pace = paceFor({ train: 3 })!;
    expect(pace(true)).toBe(1);
    expect(pace(false)).toBeCloseTo(unitById.get("train")!.speed / unitById.get("train")!.offRailSpeed!);
    expect(paceFor({ freight_wagon: 2 })).toBeUndefined();
    expect(paceFor({ train: 1, swordsman: 1 })).toBeUndefined();
    // Somewhere on the map: A and D two hops apart through B or through C. Track on A, C and D (not B): the shortest way
    // goes by B, the quickest for a train by C.
    let found: { a: string; b: string; c: string; d: string } | null = null;
    // A Railway region has Roads too, so the track regions are road regions as well.
    const leg = (x: string, y: string, rails?: ReadonlySet<string>, p?: (t: boolean) => number) => findRoute(x, y, false, rails, rails, undefined, undefined, p)!.cost;
    search: for (const a of allRegions()) {
      for (const d of allRegions()) {
        if (d === a || a.neighbors.includes(d.id)) continue;
        const mids = a.neighbors.filter((m) => d.neighbors.includes(m));
        for (const b of mids)
          for (const c of mids) {
            if (b === c) continue;
            const rails = new Set([a.id, c, d.id]);
            const viaB = leg(a.id, b) + leg(b, d.id);
            const viaC = leg(a.id, c) + leg(c, d.id);
            if (viaB >= viaC) continue;
            const trainB = leg(a.id, b, rails, pace) + leg(b, d.id, rails, pace);
            const trainC = leg(a.id, c, rails, pace) + leg(c, d.id, rails, pace);
            if (trainC < trainB) { found = { a: a.id, b, c, d: d.id }; break search; }
          }
      }
    }
    expect(found, "two ways of two hops where the track makes the longer one quicker").toBeTruthy();
    const { a, b, c, d } = found!;
    const rails = new Set([a, c, d]);
    expect(findRoute(a, d, false)!.path).toEqual([a, b, d]);
    const train = findRoute(a, d, false, rails, rails, undefined, undefined, pace)!;
    expect(train.path).toEqual([a, c, d]);
    // Its cost is time at the train's top speed: the track legs at the road rate (the train's speed is the track's gain).
    expect(train.cost).toBeCloseTo(findRoute(a, c, false, rails)!.cost + findRoute(c, d, false, rails)!.cost, 6);
    // Armies on the same track keep the rail cut.
    expect(findRoute(a, c, false, undefined, rails)!.cost).toBeCloseTo(findRoute(a, c, false)!.cost * balance.travel.railBothFactor, 6);
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
    // By water the ships set the pace, whatever they carry: galleys with catapults and settlers sail at galley speed.
    expect(armySpeed({ galley: 2, catapult: 4, settler: 5 })).toBe(unitById.get("galley")!.speed);
    expect(armySpeed({ galley: 2, cog: 1, swordsman: 9 })).toBe(Math.min(unitById.get("galley")!.speed, unitById.get("cog")!.speed));
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

describe("moving groups are named by their best hauler", () => {
  it("lorries, trains, freight wagons, wagons, caravans", () => {
    expect(missionLabel("transport", { lorry: 1, wagon: 2 })).toBe("Lorries");
    expect(missionLabel("transport", { train: 1 })).toBe("Trains");
    expect(missionLabel("transport", { freight_wagon: 3 })).toBe("Freight wagons");
    expect(missionLabel("transport", { wagon: 3 })).toBe("Wagons");
    expect(missionLabel("transport", { caravan: 1 })).toBe("Caravans");
  });
});

import { haulFactor, isHaulerConvoy } from "../src/rules/travel.js";
import { effectsOf } from "../src/rules/buildings.js";

describe("waystations", () => {
  it("count per level, cut every hauler leg ending in their region, multiply along the route and stop at the cap", () => {
    expect(effectsOf({ waystation: 3 }).haul).toBeCloseTo(0.06);
    const stations = new Map([["b", 0.1], ["c", 0.5]]);
    expect(haulFactor(["a", "b"], stations)).toBeCloseTo(0.9);
    expect(haulFactor(["a", "b", "c"], stations)).toBeCloseTo(0.9 * (1 - balance.travel.waystationMaxCut));
    expect(haulFactor(["b", "a"], stations)).toBe(1);
  });
  it("serve convoys of land haulers only", () => {
    expect(isHaulerConvoy({ wagon: 2 })).toBe(true);
    expect(isHaulerConvoy({ wagon: 2, warrior: 1 })).toBe(false);
    expect(isHaulerConvoy({ cog: 1 })).toBe(false);
    expect(isHaulerConvoy({})).toBe(false);
  });
});

import { laneLimitKm } from "../src/rules/travel.js";
import { availableUnits } from "../src/rules/buildings.js";

describe("canoes", () => {
  it("keep a crossing to the short lanes, while ships and land units are free", () => {
    expect(laneLimitKm({ canoe: 1, settler: 5 })).toBe(balance.travel.canoeMaxLaneKm);
    expect(laneLimitKm({ galley: 1 })).toBeNull();
    expect(laneLimitKm({ warrior: 3 })).toBeNull();
  });
  it("stay trainable beside bigger land haulers: boats are their own ladder", () => {
    const ids = availableUnits(2, new Set(["sailing", "wagon_building", "shipbuilding"])).map((u) => u.id);
    expect(ids).toContain("canoe");
    expect(ids).toContain("wagon");
    expect(ids).not.toContain("caravan");
  });
});

import { airRangeKm, airRoute, isAirGroup, seaPath, nextHopTo } from "../src/rules/travel.js";
import { distanceKm } from "../src/map/index.js";

describe("aircraft", () => {
  it("fly alone, within the shortest range aboard, on one straight leg", () => {
    expect(isAirGroup({ bomber: 3 })).toBe(true);
    expect(isAirGroup({ bomber: 3, warrior: 1 })).toBe(false);
    expect(isAirGroup({})).toBe(false);
    expect(airRangeKm({ bomber: 2, scout_plane: 1 })).toBe(Math.min(unitById.get("bomber")!.rangeKm!, unitById.get("scout_plane")!.rangeKm!));
    const r = airRoute("cd-katanga", "mm-sagaing");
    expect(r.path).toEqual(["cd-katanga", "mm-sagaing"]);
    expect(r.cost).toBeCloseTo(distanceKm("cd-katanga", "mm-sagaing"));
    expect(r.usesSea).toBe(false);
  });
});

describe("voyages", () => {
  it("goods for a far holding over the sea take ship rather than march through strangers' land, though a land route exists", () => {
    // East Africa and the Horn are ours; a strip of India's south-east coast is too. Land runs round by Arabia, Iran and Pakistan.
    const ours = new Set(["so-somalia", "ke-north-eastern", "et-afar", "er-eritrea", "tz-manyara", "in-tamil-nadu"]);
    expect(findRoute("so-somalia", "in-tamil-nadu", false), "a land route exists").not.toBeNull();
    // Blind to who holds what, the land route wins.
    expect(nextHopTo("so-somalia", "in-tamil-nadu")).toMatchObject({ hop: "in-tamil-nadu", bySea: false });
    // Knowing it, and with cargo ships to carry them, the goods sail; without ships they keep to land.
    expect(nextHopTo("so-somalia", "in-tamil-nadu", (id) => ours.has(id))).toMatchObject({ bySea: false });
    const way = nextHopTo("so-somalia", "in-tamil-nadu", (id) => ours.has(id), true);
    expect(way?.bySea, JSON.stringify(way)).toBe(true);
    // From North Africa the cheapest way with the sea allowed crosses twice (the Mediterranean, then the Red Sea to
    // India); the one-crossing way is still found: overland to a harbour of ours on the Red Sea, then by ship.
    const north = new Set([...ours, "tn-tunisia", "sd-red-sea"]);
    const fromTunisia = nextHopTo("tn-tunisia", "in-tamil-nadu", (id) => north.has(id), true);
    expect(fromTunisia, JSON.stringify(fromTunisia)).toMatchObject({ relay: true, bySea: false });
    expect(north.has(fromTunisia!.hop), fromTunisia!.hop).toBe(true);
    // The risk only steers the choice: the route's cost stays the real distance.
    const plain = findRoute("so-somalia", "in-tamil-nadu", false)!;
    const risky = findRoute("so-somalia", "in-tamil-nadu", false, undefined, undefined, undefined, (id) => (ours.has(id) ? 0 : balance.travel.unfriendlyRiskKm))!;
    expect(risky.weight!).toBeGreaterThan(risky.cost);
    expect(risky.cost).toBeGreaterThanOrEqual(plain.cost - 1e-6);
  });

  it("chain lanes along the coast, each within the ship's limit, and refuse what no chain reaches", () => {
    const limit = balance.travel.canoeMaxLaneKm;
    // Somewhere on the map two coasts have no short lane between them but a chain of short lanes along the coast.
    let found: { a: string; b: string } | null = null;
    for (const a of allRegions()) {
      if (!a.coastal) continue;
      for (const b of allRegions()) {
        if (b === a || !b.coastal || a.seaRoutes.includes(b.id)) continue;
        const p = seaPath(a.id, b.id, limit);
        if (p && p.path.length >= 3) { found = { a: a.id, b: b.id }; break; }
      }
      if (found) break;
    }
    expect(found, "two coasts joined by a chain of short lanes but no single one").toBeTruthy();
    const voyage = seaPath(found!.a, found!.b, limit)!;
    expect(voyage.usesSea).toBe(true);
    for (let i = 1; i < voyage.path.length; i++) expect(distanceKm(voyage.path[i - 1]!, voyage.path[i]!)).toBeLessThanOrEqual(limit);
    expect(seaPath(found!.a, found!.b, 10)).toBeNull();
    // Japan sits beyond every canoe lane: a cog's voyage exists, a canoe's does not.
    expect(seaPath("kr-south-korea", "jp-japan", Infinity)).not.toBeNull();
    expect(seaPath("kr-south-korea", "jp-japan", limit)).toBeNull();
    // A chain of lanes is one voyage for the goods: the hand-over is at the near harbour, the hop its far end.
    const hop = nextHopTo(found!.a, found!.b);
    expect(hop).not.toBeNull();
    // Open water between them: Gabon to Pernambuco is one straight crossing, not a landing at Paraiba and a walk.
    expect(nextHopTo("ga-gabon", "br-pernambuco")).toEqual({ hop: "br-pernambuco", relay: false, bySea: true });
    // A voyage that would land at a harbour nobody friendly holds sails on to a coastal destination, or finds no way.
    let relayed: { x: string; y: string; h: { hop: string; relay: boolean } } | null = null;
    const coasts = allRegions().filter((r) => r.coastal);
    search: for (const x of coasts.slice(0, 40))
      for (const y of coasts) {
        if (y === x || x.seaRoutes.includes(y.id)) continue;
        const h = nextHopTo(x.id, y.id);
        if (h?.relay) {
          relayed = { x: x.id, y: y.id, h };
          break search;
        }
      }
    if (relayed) {
      const away = nextHopTo(relayed.x, relayed.y, (id) => id !== relayed.h!.hop);
      expect(away === null || away.hop !== relayed.h!.hop).toBe(true);
    }
    // A region with two coasts the sea does not join along its shore is never sailed through from one to the other: every
    // voyage keeps to one stretch of coast through each region it passes, so the Red Sea to the Mediterranean goes round
    // Africa and in by Gibraltar, not over Suez.
    const check = (p: string[]) => {
      for (let i = 1; i < p.length - 1; i++) {
        const r = allRegions().find((x) => x.id === p[i])!;
        const inCoast = r.laneCoasts?.[p[i - 1]!];
        const outCoast = r.laneCoasts?.[p[i + 1]!];
        if (inCoast !== undefined && outCoast !== undefined) expect(inCoast, `${r.name} crossed from one coast to another`).toBe(outCoast);
      }
    };
    const suez = seaPath("sa-al-madinah", "sy-syria", Infinity);
    expect(suez).not.toBeNull();
    check(suez!.path);
    expect(suez!.path.length).toBeGreaterThan(8);
    const long = seaPath("mz-niassa", "ga-gabon", Infinity);
    expect(long).not.toBeNull();
    check(long!.path);
    // The Atlantic has crossings of its own: West Africa to Brazil is a short hop over open sea, not the long way by
    // Iceland and Greenland round the rim of the ocean.
    const atlantic = seaPath("ga-gabon", "br-paraiba", Infinity);
    expect(atlantic).not.toBeNull();
    expect(atlantic!.path.length).toBeLessThanOrEqual(6);
    expect(atlantic!.path.some((id) => id === "is-iceland" || id.startsWith("gl-"))).toBe(false);
    check(atlantic!.path);
  });
});
