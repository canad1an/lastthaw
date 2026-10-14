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

export function buildingCost(def: BuildingDef, level: number): Cost {
  const g = Math.pow(balance.timers.costGrowth, Math.max(0, level - 1));
  return scaleCost(def.cost, g);
}

export function unitCost(def: UnitDef, qty: number): Cost {
  return scaleCost(def.cost, qty);
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
