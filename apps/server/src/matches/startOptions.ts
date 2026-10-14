import { createHash } from "node:crypto";
import { allRegions, balance, distanceKm, regionById, type MapRegion } from "@lastthaw/shared";

/** Regions good enough to start in: temperate-ish, not frozen or barren, with some neighbours. */
export function eligibleStarts(): MapRegion[] {
  return allRegions().filter(
    (r) => r.terrain !== "tundra" && r.terrain !== "desert" && r.neighbors.length >= 2 && Math.abs(r.lat) <= 55 && r.value >= 0.6,
  );
}

export function farEnough(regionId: string, takenCapitals: readonly string[]): boolean {
  const r = regionById(regionId);
  if (!r) return false;
  return takenCapitals.every((t) => {
    const o = regionById(t);
    return !o || distanceKm(r, o) >= balance.match.minCapitalSpacingKm;
  });
}

/** Deterministic shuffle seeded by match seed and the joining user. */
function seededOrder<T>(items: T[], seed: string): T[] {
  const keyed = items.map((item, i) => ({
    item,
    k: createHash("sha256").update(`${seed}:${i}`).digest().readUInt32BE(0),
  }));
  keyed.sort((a, b) => a.k - b.k);
  return keyed.map((k) => k.item);
}

/**
 * Candidate capitals for a player: spread out from everyone already placed.
 * Players who pick late in a crowded match get fewer options, never zero.
 */
export function startOptionsFor(matchSeed: string, userKey: string, takenCapitals: readonly string[]): string[] {
  const pool = seededOrder(eligibleStarts(), `${matchSeed}:${userKey}`);
  const free = pool.filter((r) => !takenCapitals.includes(r.id) && farEnough(r.id, takenCapitals));
  const n = balance.match.startOptions;
  if (free.length >= n) return free.slice(0, n).map((r) => r.id);
  // Relax spacing if the map is crowded.
  const relaxed = pool.filter((r) => !takenCapitals.includes(r.id));
  return [...new Set([...free, ...relaxed])].slice(0, n).map((r) => r.id);
}
