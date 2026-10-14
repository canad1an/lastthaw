import { balance } from "../config/balance.js";
import { distanceKm } from "../map/index.js";

export interface LoyaltyOutlook {
  /** Where loyalty is heading (0..1). */
  target: number;
  /** Pieces of the target, for explaining it. */
  km: number;
  distancePenalty: number;
  buildingBonus: number;
  occupierFactor: number;
  occupiersNeeded: number;
  /** Below this the region may rebel each tick. */
  rebelBelow: number;
  /** Game hours until loyalty gets within 0.02 of the target at the current rate. */
  hoursToSettle: number;
}

/**
 * The same formula the match tick uses for a non-capital region: distance from
 * the capital sets the base, loyalty buildings add to it, and missing occupiers
 * halve it. Capitals are always fully loyal.
 */
export function loyaltyOutlook(regionId: string, capitalId: string | null, buildingLoyalty: number, population: number, occupiers: number, current: number, conquered = true): LoyaltyOutlook {
  const c = balance.conquest;
  if (!capitalId || capitalId === regionId) {
    return { target: 1, km: 0, distancePenalty: 0, buildingBonus: 0, occupierFactor: 1, occupiersNeeded: 0, rebelBelow: c.rebelBelow, hoursToSettle: 0 };
  }
  const km = distanceKm(capitalId, regionId);
  const distancePenalty = Math.min(1, km / c.distanceScaleKm);
  const occupiersNeeded = conquered ? (population / 100) * c.occupiersPerHundred : 0;
  const occupierFactor = occupiersNeeded > 0 ? Math.min(1, occupiers / occupiersNeeded) : 1;
  const target = Math.max(0, Math.min(1, 1 - distancePenalty + buildingLoyalty)) * (0.5 + 0.5 * occupierFactor);
  const gap = Math.abs(target - current);
  // loyalty += (target - loyalty) * rate * hours each tick: exponential approach, solve for 0.02 remaining.
  const hoursToSettle = gap <= 0.02 ? 0 : Math.log(gap / 0.02) / c.loyaltyRate;
  return { target, km, distancePenalty, buildingBonus: buildingLoyalty, occupierFactor, occupiersNeeded, rebelBelow: c.rebelBelow, hoursToSettle };
}

/** Colour band for the map overlay and labels. */
export function loyaltyBand(loyalty: number): "secure" | "uneasy" | "rebellious" {
  if (loyalty < balance.conquest.rebelBelow) return "rebellious";
  if (loyalty < 0.6) return "uneasy";
  return "secure";
}
