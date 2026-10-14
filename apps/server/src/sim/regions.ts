import { and, eq, sql } from "drizzle-orm";
import {
  balance,
  computeRates,
  regionById,
  settle,
  startingEconomy,
  type Rates,
  type RegionEconomy,
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

export function economyOf(row: MatchRegionRow): RegionEconomy {
  const base = balance.economy.baseStorage;
  const mult = 1 + row.storageLevel * 0.5;
  return {
    popWorkers: row.popWorkers,
    popSoldiers: row.popSoldiers,
    popOccupiers: row.popOccupiers,
    food: row.food,
    wood: row.wood,
    stone: row.stone,
    assignment: row.assignment,
    storage: { food: base.food * mult, wood: base.wood * mult, stone: base.stone * mult },
    capacity: balance.economy.baseCapacity,
    frozen: row.frozenAt !== null,
  };
}

/** Pure projection of a row to `asOf`. Does not touch the database. */
export function projectRegion(row: MatchRegionRow, asOf: Date, speed: number): { economy: RegionEconomy; rates: Rates } {
  const traits = traitsOf(row.regionId);
  const economy = settle(traits, economyOf(row), elapsedSeconds(row.settledAt, asOf), speed);
  return { economy, rates: computeRates(traits, economy) };
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
    .set({
      popWorkers: economy.popWorkers,
      popSoldiers: economy.popSoldiers,
      popOccupiers: economy.popOccupiers,
      food: economy.food,
      wood: economy.wood,
      stone: economy.stone,
      settledAt: asOf,
    })
    .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId)))
    .returning();
  if (!updated) throw new Error("settle update failed");
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
      popWorkers: e.popWorkers,
      popSoldiers: 0,
      popOccupiers: 0,
      food: e.food,
      wood: e.wood,
      stone: e.stone,
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
