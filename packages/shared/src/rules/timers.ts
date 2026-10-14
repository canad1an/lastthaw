import { balance } from "../config/balance.js";
import type { BuildingDef, Cost, TechDef, UnitDef } from "../config/ages.js";
import { scaledDuration } from "./time.js";

/**
 * Timer curve: level 1 takes `baseSeconds`, each level multiplies by
 * `timers.levelGrowth`, nothing exceeds `timers.maxSeconds`. Later ages have
 * larger base seconds in the content tables, which gives the spec's curve of
 * seconds on day one, minutes by day three and hours by week two.
 */
export function buildingSeconds(def: BuildingDef, level: number): number {
  const t = balance.timers;
  return Math.min(t.maxSeconds, def.baseSeconds * Math.pow(t.levelGrowth, Math.max(0, level - 1)));
}

/** Cost multiplier on a given match day (linear between the points in balance.timers.dayCost). */
export function dayCostMultiplier(day: number): number {
  const pts = balance.timers.dayCost;
  if (day <= pts[0]!.day) return pts[0]!.mult;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (day <= b.day) return a.mult + ((b.mult - a.mult) * (day - a.day)) / (b.day - a.day);
  }
  return pts[pts.length - 1]!.mult;
}

export function buildingCost(def: BuildingDef, level: number, day = 0, neighbors = 1): Cost {
  const g = Math.pow(balance.timers.costGrowth, Math.max(0, level - 1));
  return scaleCost(def.cost, g * dayCostMultiplier(day) * (def.perNeighbor ? Math.max(1, neighbors) : 1));
}

/** Age advances are priced in absolute empire wealth (paid from every region) and do not scale with the day; other techs do. */
export function techCost(def: TechDef, day = 0): Cost {
  return scaleCost(def.cost, def.advancesTo !== undefined ? 1 : dayCostMultiplier(day));
}

export function unitCost(def: UnitDef, qty: number, day = 0): Cost {
  return scaleCost(def.cost, qty * Math.sqrt(dayCostMultiplier(day)));
}

/** Training a batch takes longer than one unit, but with a volume discount. */
export function trainSeconds(def: UnitDef, qty: number): number {
  const t = balance.timers;
  return Math.min(t.maxSeconds, def.baseSeconds * Math.pow(qty, t.batchExponent));
}

export function techSeconds(def: TechDef): number {
  return Math.min(balance.timers.maxSeconds, def.baseSeconds);
}

export function scaleCost(cost: Cost, factor: number): Cost {
  const out: Cost = {};
  for (const [k, v] of Object.entries(cost)) out[k as keyof Cost] = Math.ceil(v * factor);
  return out;
}

/** Apply a speed bonus (e.g. 0.3 for 30 % faster) and the match speed. Returns real seconds. */
export function realSeconds(baseSeconds: number, speedBonus: number, matchSpeed: number): number {
  const eff = baseSeconds / (1 + Math.max(0, speedBonus));
  return scaledDuration(eff, matchSpeed);
}

export function canAfford(stock: Record<string, number>, cost: Cost): boolean {
  return Object.entries(cost).every(([k, v]) => (stock[k] ?? 0) >= v);
}

export function missingFor(stock: Record<string, number>, cost: Cost): string[] {
  return Object.entries(cost)
    .filter(([k, v]) => (stock[k] ?? 0) < v)
    .map(([k]) => k);
}

/** Match day right now from a match view (ISO startsAt + speed) and the client's clock offset. */
export function matchDayOf(state: { match: { startsAt: string | null; speed: number; lengthDays?: number } }, clockOffsetMs: number, now = Date.now()): number {
  if (!state.match.startsAt) return 0;
  return Math.max(0, ((now + clockOffsetMs - Date.parse(state.match.startsAt)) / 86400_000) * state.match.speed);
}
