import { and, eq, sql } from "drizzle-orm";
import {
  balance,
  computeRates,
  effectsOf,
  emptySpecial,
  regionById,
  settle,
  startingEconomy,
  storageCaps,
  SPECIAL_RESOURCES,
  type Cost,
  type Rates,
  type RegionEconomy,
  type RegionEffects,
  type RegionTraits,
} from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matchRegions } from "../db/schema.js";
import { elapsedSeconds } from "./clock.js";

export type MatchRegionRow = typeof matchRegions.$inferSelect;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function traitsOf(regionId: string): RegionTraits {
  const r = regionById(regionId);
  if (!r) throw new Error(`unknown region ${regionId}`);
  return { terrain: r.terrain, resources: r.resources, coastal: r.coastal, river: r.river };
}

export function economyOf(row: MatchRegionRow, effects: RegionEffects = effectsOf(row.buildings)): RegionEconomy {
  const special = { ...emptySpecial(), ...(row.special as Partial<Record<(typeof SPECIAL_RESOURCES)[number], number>>) };
  return {
    popWorkers: row.popWorkers,
    popSoldiers: row.popSoldiers,
    popOccupiers: row.popOccupiers,
    food: row.food,
    wood: row.wood,
    stone: row.stone,
    special,
    assignment: row.assignment,
    storage: storageCaps(effects),
    capacity: balance.economy.baseCapacity + effects.capacity,
    yieldMult: effects.yield,
    extract: effects.extract,
    frozen: row.frozenAt !== null,
  };
}

/** Pure projection of a row to `asOf`. Does not touch the database. */
export function projectRegion(row: MatchRegionRow, asOf: Date, speed: number): { economy: RegionEconomy; rates: Rates; effects: RegionEffects } {
  const traits = traitsOf(row.regionId);
  const effects = effectsOf(row.buildings);
  const economy = settle(traits, economyOf(row, effects), elapsedSeconds(row.settledAt, asOf), speed);
  return { economy, rates: computeRates(traits, economy), effects };
}

function economyColumns(e: RegionEconomy) {
  return {
    popWorkers: e.popWorkers,
    popSoldiers: e.popSoldiers,
    popOccupiers: e.popOccupiers,
    food: e.food,
    wood: e.wood,
    stone: e.stone,
    special: e.special,
  };
}

/**
 * Lock a region row, settle it to `asOf`, persist, and return the fresh row.
 * Call this inside a transaction before any write that changes a rate.
 */
export async function settleAndLockRegion(tx: Tx, matchId: string, regionId: string, asOf: Date, speed: number): Promise<MatchRegionRow> {
  const rows = await tx
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId)))
    .for("update");
  const row = rows[0];
  if (!row) throw Object.assign(new Error("region not found"), { statusCode: 404 });
  if (asOf.getTime() <= row.settledAt.getTime()) return row;
  const { economy } = projectRegion(row, asOf, speed);
  const [updated] = await tx
    .update(matchRegions)
    .set({ ...economyColumns(economy), settledAt: asOf })
    .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId)))
    .returning();
  if (!updated) throw new Error("settle update failed");
  return updated;
}

/** Stock of every payable resource in a (settled) row. */
export function stockOf(row: MatchRegionRow): Record<string, number> {
  return { food: row.food, wood: row.wood, stone: row.stone, ...emptySpecial(), ...(row.special as Record<string, number>) };
}

/** Deduct (or with negative factor, refund) a cost from a settled, locked row. Caller checks affordability. */
export async function applyCost(tx: Tx, row: MatchRegionRow, cost: Cost, factor = 1): Promise<MatchRegionRow> {
  const special: Record<string, number> = { ...emptySpecial(), ...(row.special as Record<string, number>) };
  const set: Partial<MatchRegionRow> = {};
  for (const [k, v] of Object.entries(cost)) {
    const delta = v * factor;
    if (k === "food" || k === "wood" || k === "stone") {
      set[k] = Math.max(0, row[k] - delta);
    } else if (k in special) {
      special[k] = Math.max(0, (special[k] ?? 0) - delta);
    }
  }
  set.special = special;
  const [updated] = await tx
    .update(matchRegions)
    .set(set)
    .where(and(eq(matchRegions.matchId, row.matchId), eq(matchRegions.regionId, row.regionId)))
    .returning();
  if (!updated) throw new Error("cost update failed");
  return updated;
}

/** Found a capital for a player at match start. */
export async function foundCapital(tx: Tx, matchId: string, playerId: string, regionId: string, at: Date): Promise<void> {
  const e = startingEconomy();
  await tx
    .insert(matchRegions)
    .values({
      matchId,
      regionId,
      ownerPlayerId: playerId,
      ...economyColumns(e),
      assignment: e.assignment,
      settledAt: at,
    })
    .onConflictDoUpdate({
      target: [matchRegions.matchId, matchRegions.regionId],
      set: { ownerPlayerId: playerId, settledAt: at },
    });
}

export async function countOwnedRegions(db: Db | Tx, matchId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ owner: matchRegions.ownerPlayerId, n: sql<number>`count(*)::int` })
    .from(matchRegions)
    .where(eq(matchRegions.matchId, matchId))
    .groupBy(matchRegions.ownerPlayerId);
  const m = new Map<string, number>();
  for (const r of rows) if (r.owner) m.set(r.owner, r.n);
  return m;
}
