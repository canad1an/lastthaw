import { and, eq } from "drizzle-orm";
import { balance, carryCapacity, emptySpecial } from "@lastthaw/shared";
import { matchRegions, tradeRoutes } from "../db/schema.js";
import { matchNow } from "./clock.js";
import { settleAndLockRegion, stockOf } from "./regions.js";
import { httpError, sendArmy, type CommandContext } from "./commands.js";

/**
 * Evacuate a region: every unit and every person (occupiers included) leaves
 * for `toRegionId` as a Move mission, carrying as much stock as they can.
 * The region stays yours, empty, and will freeze or be reclaimed in time.
 */
export async function evacuateRegion(ctx: CommandContext, regionId: string, toRegionId: string) {
  const { db, m, p } = ctx;
  // Occupiers become ordinary travellers; settle first so stock is current.
  const snapshot = await db.transaction(async (tx) => {
    const row = await settleAndLockRegion(tx, m.id, regionId, matchNow(m), m.speed);
    if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    if (row.evacuatedAt) throw httpError(409, "this region has already been evacuated");
    if (row.popOccupiers > 0) {
      await tx
        .update(matchRegions)
        .set({ popWorkers: row.popWorkers + row.popOccupiers, popOccupiers: 0 })
        .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, regionId)));
    }
    return { ...row, popWorkers: row.popWorkers + row.popOccupiers, popOccupiers: 0 };
  });
  const units = Object.fromEntries(Object.entries(snapshot.units).filter(([, n]) => n > 0));
  const people = Math.floor(snapshot.popWorkers);
  if (people < 1 && Object.keys(units).length === 0) throw httpError(409, "nobody is left to evacuate");
  const capacity = carryCapacity(units, ctx.techs) + people * balance.travel.carryPerPerson;
  // Fill the wagons: food first (they must eat on arrival), then wood, stone, metals.
  const special = { ...emptySpecial(), ...(snapshot.special as Record<string, number>) };
  const stock: Array<[string, number]> = [
    ["food", snapshot.food],
    ["wood", snapshot.wood],
    ["stone", snapshot.stone],
    ...Object.entries(special),
  ];
  const cargo: Record<string, number> = {};
  let left = capacity;
  for (const [k, have] of stock) {
    const take = Math.floor(Math.min(have, left));
    if (take >= 1) {
      cargo[k] = take;
      left -= take;
    }
    if (left <= 0) break;
  }
  const result = await sendArmy(ctx, regionId, { mission: "move", targetRegionId: toRegionId, units, people, cargo });
  // Nobody stays: the odd fraction of a person leaves too. The stores follow on a stock-up route (haulers are fetched as needed).
  await db.transaction(async (tx) => {
    const row = await settleAndLockRegion(tx, m.id, regionId, matchNow(m), m.speed);
    await tx
      .update(matchRegions)
      .set({ evacuatedAt: matchNow(m), popWorkers: 0, popOccupiers: 0 })
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, regionId)));
    const left = stockOf(row);
    const target: Record<string, number> = {};
    for (const [k, v] of Object.entries(left)) if (v >= 1) target[k] = Math.floor(v);
    if (Object.keys(target).length && !row.frozenAt) {
      await tx.insert(tradeRoutes).values({
        matchId: m.id,
        playerId: p.id,
        fromRegionId: regionId,
        toRegionId: toRegionId,
        mode: "fixed",
        load: target,
        share: 0,
        caravans: 5,
        everyHours: 1,
        target,
        delivered: {},
        nextAt: matchNow(m),
      });
    }
  });
  return { army: result.army, people, units, cargo, leftBehind: Math.max(0, snapshot.food + snapshot.wood + snapshot.stone - Object.values(cargo).reduce((a, b) => a + b, 0)) };
}

/**
 * Disband stationed units: they put down their weapons and rejoin the
 * workers of the region. Nothing is refunded. Civilians (settlers, caravans)
 * disband the same way.
 */
export async function disbandUnits(ctx: CommandContext, regionId: string, units: Record<string, number>) {
  const { db, m, p } = ctx;
  return db.transaction(async (tx) => {
    const row = await settleAndLockRegion(tx, m.id, regionId, matchNow(m), m.speed);
    if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    const next = { ...(row.units as Record<string, number>) };
    let n = 0;
    for (const [id, want] of Object.entries(units)) {
      const have = next[id] ?? 0;
      const take = Math.max(0, Math.min(Math.floor(want), have));
      if (take === 0) continue;
      next[id] = have - take;
      n += take;
    }
    if (n === 0) throw httpError(409, "no units to disband");
    await tx
      .update(matchRegions)
      .set({ units: next, popSoldiers: Math.max(0, row.popSoldiers - n), popWorkers: row.popWorkers + n })
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, regionId)));
    return { disbanded: n };
  });
}
