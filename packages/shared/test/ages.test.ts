import { describe, expect, it } from "vitest";
import { AGES, BUILDINGS, BUILDING_CATEGORIES, TECHS, UNITS, buildingById, techById, unitById } from "../src/config/ages.js";
import { balance } from "../src/config/balance.js";
import { availableBuildings, availableTechs, availableUnits, effectsOf, techEffectsOf, wallOf } from "../src/rules/buildings.js";

const nonNegativeCost = (cost: Record<string, number | undefined>) => Object.values(cost).every((v) => v === undefined || (Number.isFinite(v) && v >= 0));

/** The age tables are hand-written data; every cross-reference in them must resolve. */
describe("age data", () => {
  it("has seven ages and unique ids across buildings, units and techs", () => {
    expect(AGES).toHaveLength(7);
    for (const list of [BUILDINGS, UNITS, TECHS] as const) expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    const all = [...BUILDINGS.map((b) => b.id), ...UNITS.map((u) => u.id), ...TECHS.map((t) => t.id)];
    expect(new Set(all).size).toBe(all.length);
  });

  it("every building has a valid age, category, cost and timer", () => {
    const categories = new Set(BUILDING_CATEGORIES.map((c) => c.id));
    for (const b of BUILDINGS) {
      expect(b.age, b.id).toBeGreaterThanOrEqual(0);
      expect(b.age, b.id).toBeLessThanOrEqual(6);
      expect(categories.has(b.category), b.id).toBe(true);
      expect(b.maxLevel, b.id).toBeGreaterThanOrEqual(1);
      expect(b.baseSeconds, b.id).toBeGreaterThan(0);
      expect(nonNegativeCost(b.cost), b.id).toBe(true);
      expect(Object.keys(b.cost).length, b.id).toBeGreaterThan(0);
      if (b.requires) expect(techById.has(b.requires), `${b.id} requires ${b.requires}`).toBe(true);
      if (b.requiresBuilding) expect(buildingById.has(b.requiresBuilding), `${b.id} requiresBuilding ${b.requiresBuilding}`).toBe(true);
      expect(b.name.length, b.id).toBeGreaterThan(1);
      expect(b.description.length, b.id).toBeGreaterThan(5);
    }
  });

  it("every unit has a valid age, speed, cost, timer and references", () => {
    for (const u of UNITS) {
      expect(u.age, u.id).toBeGreaterThanOrEqual(0);
      expect(u.age, u.id).toBeLessThanOrEqual(6);
      // Militia never leave home (speed 0); everything else marches.
      if (u.id === "militia") expect(u.speed).toBe(0);
      else expect(u.speed, u.id).toBeGreaterThan(0);
      expect(u.attack, u.id).toBeGreaterThanOrEqual(0);
      expect(u.defense, u.id).toBeGreaterThanOrEqual(0);
      expect(u.carry, u.id).toBeGreaterThanOrEqual(0);
      // Mercenaries are hired and militia rise on their own: neither is trained.
      if (u.mercenary || u.id === "militia") expect(u.baseSeconds, `${u.id} is never trained`).toBe(0);
      else expect(u.baseSeconds, u.id).toBeGreaterThan(0);
      expect(nonNegativeCost(u.cost), u.id).toBe(true);
      if (u.requires) expect(techById.has(u.requires), `${u.id} requires ${u.requires}`).toBe(true);
      if (u.needsBuilding) expect(buildingById.has(u.needsBuilding), `${u.id} needsBuilding ${u.needsBuilding}`).toBe(true);
      if (u.hauler) expect(u.carry, `${u.id} is a hauler`).toBeGreaterThan(0);
      if (u.mercenary) expect(u.hidden, `${u.id} is a mercenary, so never trainable`).toBe(true);
      if (u.naval && !u.shortLanes) expect(u.needsBuilding, `${u.id} is a ship`).toBeTruthy();
    }
    expect(unitById.get("warrior")?.age).toBe(0);
    expect(unitById.get("settler")?.civilian).toBe(true);
    expect(unitById.get("caravan")?.hauler).toBe(true);
  });

  it("every tech has a valid age, cost, timer and prerequisites that come no later than it", () => {
    for (const t of TECHS) {
      expect(t.age, t.id).toBeGreaterThanOrEqual(0);
      expect(t.age, t.id).toBeLessThanOrEqual(6);
      expect(t.baseSeconds, t.id).toBeGreaterThan(0);
      expect(nonNegativeCost(t.cost), t.id).toBe(true);
      for (const r of t.requires ?? []) {
        expect(techById.has(r), `${t.id} requires ${r}`).toBe(true);
        expect(techById.get(r)!.age, `${t.id} requires ${r} from a later age`).toBeLessThanOrEqual(t.age);
      }
      if (t.advancesTo !== undefined) expect(t.advancesTo, t.id).toBe(t.age + 1);
    }
  });

  it("every age after the first is reachable through one advancing tech, with no prerequisite cycles", () => {
    for (let age = 0; age < 6; age++) expect(TECHS.filter((t) => t.age === age && t.advancesTo === age + 1).length, `advance from ${AGES[age]}`).toBe(1);
    const seen = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      expect(visiting.has(id), `cycle through ${id}`).toBe(false);
      visiting.add(id);
      for (const r of techById.get(id)!.requires ?? []) visit(r);
      visiting.delete(id);
      seen.add(id);
    };
    for (const t of TECHS) visit(t.id);
  });

  it("the balance file points at real things", () => {
    expect(buildingById.get(balance.win.wonderBuilding)?.wonder).toBe(true);
    expect(buildingById.get(balance.win.wonderBuilding)?.capitalOnly).toBe(true);
    expect(techById.has(balance.travel.seaTech)).toBe(true);
    for (const key of Object.keys(balance.win.milestones)) {
      if (key === "age" || key === "wonder" || key === "daily" || key === "capital") continue;
      expect(buildingById.has(key) || unitById.has(key), `milestone ${key}`).toBe(true);
    }
    for (const id of Object.keys(balance.events.mercenaries.ironPerUnit)) expect(unitById.get(id)?.mercenary, `mercenary ${id}`).toBe(true);
    expect(balance.match.maxGameSpeed).toBeGreaterThan(balance.match.testSpeed);
    expect(balance.match.maxAiTribes).toBeLessThanOrEqual(balance.match.maxHumanPlayers);
  });

  it("availability follows age and techs", () => {
    const stone = availableBuildings(0, new Set());
    expect(stone.every((b) => b.age === 0 && !b.requires)).toBe(true);
    expect(stone.some((b) => b.id === "huts")).toBe(true);
    expect(availableUnits(0, new Set()).some((u) => u.id === "warrior")).toBe(true);
    expect(availableUnits(6, new Set(TECHS.map((t) => t.id))).some((u) => u.hidden)).toBe(false);
    const first = availableTechs(0, new Set());
    expect(first.every((t) => (t.requires ?? []).length === 0)).toBe(true);
    const done = new Set(["fire_making"]);
    const next = availableTechs(0, done);
    expect(next.some((t) => t.id === "fire_making")).toBe(false);
    expect(next.length).toBeGreaterThanOrEqual(first.length - 1);
  });

  it("building and tech effects add up", () => {
    const none = effectsOf({});
    const two = effectsOf({ huts: 2 });
    expect(two.capacity - none.capacity).toBeCloseTo(2 * (buildingById.get("huts")!.effect.capacity ?? 0));
    expect(wallOf({ huts: 1 })).toBeNull();
    // Walls are the defence buildings that add defence; a watchtower only sees, so it is not one.
    const walls = BUILDINGS.filter((b) => b.category === "defense" && (b.effect.defense ?? 0) > 0).map((b) => b.id);
    expect(walls.length).toBeGreaterThan(0);
    expect(wallOf({ [walls[0]!]: 1 })).toBe(walls[0]);
    const resist = TECHS.filter((t) => (t.effect?.plagueResist ?? 0) > 0);
    expect(resist.length).toBeGreaterThanOrEqual(2);
    expect(techEffectsOf(resist.map((t) => t.id)).plagueResist).toBeGreaterThanOrEqual(1);
    expect(techEffectsOf([]).plagueResist ?? 0).toBe(0);
  });
});

describe("the hauler ladder", () => {
  it("every unit's and building's required tech is known no later than its own age", () => {
    for (const u of unitById.values()) if (u.requires) expect(techById.get(u.requires)?.age, `${u.id} needs ${u.requires}`).toBeLessThanOrEqual(u.age);
    for (const b of buildingById.values()) if (b.requires) expect(techById.get(b.requires)?.age, `${b.id} needs ${b.requires}`).toBeLessThanOrEqual(b.age);
  });
  it("the train and Railways arrive together, in the Industrial Age, and the Railway is Roads level 2", () => {
    expect(unitById.get("train")!.age).toBe(5);
    expect(techById.get("railways")!.age).toBe(5);
    expect(buildingById.has("railway")).toBe(false);
    const roads = buildingById.get("roads")!;
    expect(roads.maxLevel).toBe(2);
    expect(roads.levelRequires?.[2]).toBe("railways");
    expect(roads.levelNames?.[2]).toBe("Railway");
    // Every tech a level needs is a real tech.
    for (const b of buildingById.values()) for (const t of Object.values(b.levelRequires ?? {})) expect(techById.has(t), `${b.id} level needs ${t}`).toBe(true);
  });
  it("each fleet rebuild comes with its age and carries more and moves faster than the one before", () => {
    const steps = Object.entries(balance.trade.fleetUpgradeTech)
      .map(([tech, unit]) => ({ tech: techById.get(tech)!, unit: unitById.get(unit)! }))
      .sort((a, b) => a.tech.age - b.tech.age);
    expect(steps.length).toBeGreaterThanOrEqual(4);
    let carry = unitById.get("caravan")!.carry;
    let speed = unitById.get("caravan")!.speed;
    for (const s of steps) {
      expect(s.tech, "fleet tech exists").toBeTruthy();
      expect(s.unit?.hauler, `${s.tech.id} rebuilds as a hauler`).toBe(true);
      expect(s.unit.age).toBeLessThanOrEqual(s.tech.age);
      expect(s.unit.carry).toBeGreaterThan(carry);
      expect(s.unit.speed).toBeGreaterThan(speed);
      carry = s.unit.carry;
      speed = s.unit.speed;
    }
  });
});
