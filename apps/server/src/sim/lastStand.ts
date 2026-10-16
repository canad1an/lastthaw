import { and, eq } from "drizzle-orm";
import { armySpeed, balance, findRoute, freezeDayForLatitude, regionById, travelSeconds, unitById } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, events, jobs, matchRegions, playerTechs, players } from "../db/schema.js";
import { alliesOf } from "./alliances.js";
import { matchNow } from "./clock.js";
import { httpError } from "./commands.js";
import { applyCost, settleAndLockRegion, stockOf, waySetsFor } from "./regions.js";
import { notify, type MatchRow } from "../worker/jobs.js";

/**
 * The last stand: once per match, when the ice is a day from the capital,
 * everything in it (every unit, every person, every store, carry limits
 * ignored) marches at double speed to an unfrozen region of yours nearer the
 * equator. The capital moves when the column arrives.
 */
export async function lastStand(db: Db, m: MatchRow, p: { id: string; capitalRegionId: string | null; lastStandAt: Date | null }, targetRegionId: string): Promise<{ armyId: string; arrivesAt: Date }> {
  const ls = balance.events.lastStand;
  if (p.lastStandAt) throw httpError(409, "the last stand has already been made");
  if (!p.capitalRegionId) throw httpError(409, "you have no capital");
  const cap = regionById(p.capitalRegionId)!;
  const target = regionById(targetRegionId);
  if (!target) throw httpError(400, "unknown region");
  const now = matchNow(m);
  const day = ((now.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed;
  const freezeDay = freezeDayForLatitude(Math.abs(cap.lat)) ?? 999;
  if (freezeDay - day > ls.withinDays) throw httpError(409, `the ice is still ${(freezeDay - day).toFixed(1)} days from your capital; the last stand is for the final day`);
  if (Math.abs(target.lat) >= Math.abs(cap.lat)) throw httpError(400, "march toward the equator, not away from it");
  const techs = new Set((await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id))).map((r) => r.id));
  const { roads, rails, harbors } = await waySetsFor(db, m.id, p.id, await alliesOf(db, m.id, p.id));
  const route = findRoute(p.capitalRegionId, targetRegionId, techs.has(balance.travel.seaTech), roads, rails, harbors);
  if (!route) throw httpError(400, "no route there");
  return db.transaction(async (tx) => {
    const ids = [p.capitalRegionId!, targetRegionId].sort();
    const locked = new Map<string, Awaited<ReturnType<typeof settleAndLockRegion>>>();
    for (const id of ids) locked.set(id, await settleAndLockRegion(tx, m.id, id, now, m.speed));
    const old = locked.get(p.capitalRegionId!)!;
    const dest = locked.get(targetRegionId)!;
    if (dest.ownerPlayerId !== p.id || dest.frozenAt) throw httpError(400, "the destination must be an unfrozen region of yours");
    // Everything goes: every unit, every person, every store, carry limits ignored.
    const units: Record<string, number> = {};
    for (const [id, n] of Object.entries(old.units)) if (n > 0) units[id] = n;
    const people = Math.floor(old.popWorkers + old.popOccupiers);
    const cargo: Record<string, number> = { people };
    for (const [k, v] of Object.entries(stockOf(old))) if (v >= 1) cargo[k] = Math.floor(v);
    const speed = (Object.keys(units).length ? armySpeed(units) : (unitById.get("settler")?.speed ?? 4)) * ls.speedMult;
    const seconds = travelSeconds(route, speed, m.speed);
    const arrivesAt = new Date(now.getTime() + seconds * 1000);
    const { people: _p, ...goods } = cargo;
    if (Object.keys(goods).length) await applyCost(tx, old, goods);
    await tx.update(matchRegions).set({ units: {}, popSoldiers: 0, popWorkers: 0, popOccupiers: 0, evacuatedAt: now }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, old.regionId)));
    const [a] = await tx
      .insert(armies)
      .values({ matchId: m.id, playerId: p.id, mission: "relocate", originRegionId: old.regionId, targetRegionId, units, cargo, path: route.path, status: "outbound", departsAt: now, arrivesAt, note: "the last stand" })
      .returning();
    await tx.insert(jobs).values({ matchId: m.id, playerId: p.id, regionId: targetRegionId, kind: "mission", refId: a!.id, startsAt: now, endsAt: arrivesAt });
    await tx.update(players).set({ lastStandAt: now }).where(eq(players.id, p.id));
    await tx.insert(events).values({ matchId: m.id, at: now, kind: "last.stand", payload: { playerId: p.id, regionId: targetRegionId, from: old.regionId } });
    await notify(tx, m.id, p.id, "system", `The last stand: ${people} people, every unit and every store leave ${regionById(old.regionId)?.name} for ${target.name} at double speed. The capital moves when they arrive.`, { regionId: targetRegionId, armyId: a!.id, lastStand: true });
    return { armyId: a!.id, arrivesAt };
  });
}
