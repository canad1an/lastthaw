import { balance } from "../config/balance.js";
import { SPECIAL_RESOURCES, type SpecialResource } from "../config/ages.js";
import { realSecondsToGameHours } from "./time.js";

export type BaseResource = "food" | "wood" | "stone";
export const BASE_RESOURCES: readonly BaseResource[] = ["food", "wood", "stone"];

/** Worker shares per gathering job. Sum should be 1; anything else is normalized. */
export type Assignment = Record<BaseResource, number>;

/** Static facts about a region that affect its economy (from the world map). */
export interface RegionTraits {
  terrain: string;
  resources: readonly string[];
  coastal: boolean;
  river: boolean;
}

/** Mutable economic state of a region plus the modifiers its buildings give it. */
export interface RegionEconomy {
  popWorkers: number;
  popSoldiers: number;
  popOccupiers: number;
  food: number;
  wood: number;
  stone: number;
  /** Metals and horses on hand. */
  special: Record<SpecialResource, number>;
  assignment: Assignment;
  /** Storage cap per base resource. */
  storage: Record<BaseResource, number>;
  /** Population capacity. */
  capacity: number;
  /** Yield multipliers from buildings (1 = none). */
  yieldMult: Record<BaseResource, number>;
  /** Extraction per game hour from buildings, applied only for resources the region has. */
  extract: Partial<Record<SpecialResource, number>>;
  /** Production multiplier from the advancing ice (1 = untouched, 0.25 at the centre, then frozen). */
  iceFactor: number;
  /** Population growth multiplier from the owner's techs (1 = none). */
  growthMult: number;
  frozen: boolean;
}

export interface Rates {
  /** Net change per game hour at the current state. */
  food: number;
  wood: number;
  stone: number;
  population: number;
  special: Record<SpecialResource, number>;
  /** Gross gathering per game hour, before consumption. */
  gross: Record<BaseResource, number>;
  starving: boolean;
}

export function emptySpecial(): Record<SpecialResource, number> {
  return { copper: 0, tin: 0, iron: 0, horses: 0 };
}

export function normalizeAssignment(a: Partial<Assignment>): Assignment {
  const food = Math.max(0, a.food ?? 0);
  const wood = Math.max(0, a.wood ?? 0);
  const stone = Math.max(0, a.stone ?? 0);
  const sum = food + wood + stone;
  if (sum <= 0) return { ...balance.start.assignment };
  return { food: food / sum, wood: wood / sum, stone: stone / sum };
}

export function totalPopulation(e: Pick<RegionEconomy, "popWorkers" | "popSoldiers" | "popOccupiers">): number {
  return e.popWorkers + e.popSoldiers + e.popOccupiers;
}

/** Gross gathering per worker-hour for one resource in a region, before building multipliers. */
export function yieldPerWorker(traits: RegionTraits, res: BaseResource): number {
  const eco = balance.economy;
  let y: number = eco.perWorkerPerHour[res];
  y *= eco.terrain[traits.terrain]?.[res] ?? 1;
  for (const r of traits.resources) y *= eco.resourceBonus[r]?.[res] ?? 1;
  if (res === "food") {
    if (traits.coastal) y *= eco.coastalFoodBonus;
    if (traits.river) y *= eco.riverFoodBonus;
  }
  return y;
}

/** Instantaneous rates for a region. Pure. */
export function computeRates(traits: RegionTraits, e: RegionEconomy): Rates {
  const eco = balance.economy;
  const pop = totalPopulation(e);
  const assignment = normalizeAssignment(e.assignment);
  const gross: Record<BaseResource, number> = { food: 0, wood: 0, stone: 0 };
  const special = emptySpecial();
  if (!e.frozen) {
    for (const res of BASE_RESOURCES) {
      gross[res] = e.popWorkers * assignment[res] * yieldPerWorker(traits, res) * (e.yieldMult[res] ?? 1) * e.iceFactor;
    }
    for (const s of SPECIAL_RESOURCES) {
      if (traits.resources.includes(s)) special[s] = (e.extract[s] ?? 0) * e.iceFactor;
    }
  }
  const consumption = (e.popWorkers + e.popOccupiers + e.popSoldiers * eco.soldierFoodMultiplier) * eco.foodPerPersonPerHour;
  const foodNet = gross.food - consumption;
  const starving = e.food <= 0 && foodNet < 0;

  let population: number;
  if (e.frozen) {
    population = -pop * eco.frozenDeathPerHour;
  } else if (starving) {
    population = -pop * eco.starvationPerHour;
  } else {
    const room = Math.max(0, 1 - pop / Math.max(1, e.capacity));
    population = (pop * eco.growthPerHour + eco.arrivalsPerHour) * room * e.growthMult;
  }

  return { food: foodNet, wood: gross.wood, stone: gross.stone, population, special, gross, starving };
}

/**
 * Advance a region's economy by `realSeconds` of real time at `speed`.
 * Deterministic and pure: same inputs always give the same output.
 * Uses fixed sub-steps because food, consumption and growth feed each other.
 */
export function settle(traits: RegionTraits, state: RegionEconomy, realSeconds: number, speed: number): RegionEconomy {
  if (realSeconds <= 0) return { ...state };
  const eco = balance.economy;
  const totalHours = realSecondsToGameHours(realSeconds, speed);
  const stepHours = eco.settleStepMinutes / 60;
  let steps = Math.ceil(totalHours / stepHours);
  let dt = stepHours;
  if (steps > eco.settleMaxSteps) {
    steps = eco.settleMaxSteps;
    dt = totalHours / steps;
  }
  const last = totalHours - dt * (steps - 1);

  let s: RegionEconomy = { ...state, assignment: normalizeAssignment(state.assignment) };
  for (let i = 0; i < steps; i++) {
    const h = i === steps - 1 ? last : dt;
    s = step(traits, s, h);
  }
  return s;
}

function step(traits: RegionTraits, s: RegionEconomy, hours: number): RegionEconomy {
  const r = computeRates(traits, s);
  const food = clamp(s.food + r.food * hours, 0, s.storage.food);
  const wood = clamp(s.wood + r.wood * hours, 0, s.storage.wood);
  const stone = clamp(s.stone + r.stone * hours, 0, s.storage.stone);
  const special = { ...s.special };
  const specialCap = balance.economy.specialStorage;
  for (const k of SPECIAL_RESOURCES) special[k] = clamp(special[k] + r.special[k] * hours, 0, specialCap);
  const pop = totalPopulation(s);
  const newPop = Math.max(0, pop + r.population * hours);
  // Growth and starvation apply to workers; soldiers and occupiers are fixed headcounts
  // that only shrink when nobody else is left.
  const fixed = s.popSoldiers + s.popOccupiers;
  let popWorkers = newPop - fixed;
  let popSoldiers = s.popSoldiers;
  let popOccupiers = s.popOccupiers;
  if (popWorkers < 0) {
    const deficit = -popWorkers;
    popWorkers = 0;
    const takeOcc = Math.min(popOccupiers, deficit);
    popOccupiers -= takeOcc;
    popSoldiers = Math.max(0, popSoldiers - (deficit - takeOcc));
  }
  return { ...s, food, wood, stone, special, popWorkers, popSoldiers, popOccupiers };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Economy of a freshly founded capital. */
export function startingEconomy(): RegionEconomy {
  const eco = balance.economy;
  return {
    popWorkers: balance.start.families * balance.start.peoplePerFamily,
    popSoldiers: 0,
    popOccupiers: 0,
    food: balance.start.food,
    wood: balance.start.wood,
    stone: balance.start.stone,
    special: emptySpecial(),
    assignment: { ...balance.start.assignment },
    storage: { ...eco.baseStorage },
    capacity: eco.baseCapacity,
    yieldMult: { food: 1, wood: 1, stone: 1 },
    extract: {},
    iceFactor: 1,
    growthMult: 1,
    frozen: false,
  };
}
