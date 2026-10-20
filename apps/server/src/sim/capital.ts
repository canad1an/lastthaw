import { and, eq } from "drizzle-orm";
import { balance, findRoute, regionById, travelSeconds } from "@lastthaw/shared";
import { armies, jobs } from "../db/schema.js";
import { matchNow } from "./clock.js";
import { alliesOf } from "./alliances.js";
import { httpError, requireRunning, type CommandContext } from "./commands.js";
import { applyCost, waySetsFor, settleAndLockRegion, stockOf, resourceMultOf } from "./regions.js";

/**
 * Move the capital: a slow wagon sets out from the old capital carrying as much of its stores as it can. The capital
 * changes when it arrives (missions.relocateCapital), and every idle caravan then gathers at the new capital. One
 * wagon at a time; the target must be yours and unfrozen, with a route.
 */
export async function relocateCapital(ctx: CommandContext, regionId: string): Promise<{ armyId: string; arrivesAt: Date; cargo: Record<string, number>; path: string[] }> {
  const { db, m, p, techs } = ctx;
  const matchId = m.id;
  if (!p.capitalRegionId) throw httpError(409, "you have no capital");
  if (p.capitalRegionId === regionId) throw httpError(409, "this is already your capital");
  const inFlight = await db
    .select({ id: armies.id, target: armies.targetRegionId, arrivesAt: armies.arrivesAt })
    .from(armies)
    .where(and(eq(armies.matchId, matchId), eq(armies.playerId, p.id), eq(armies.mission, "relocate"), eq(armies.status, "outbound")))
    .limit(1);
  if (inFlight[0]) throw httpError(409, `the capital wagon is already on its way to ${regionById(inFlight[0].target)?.name ?? "another region"}`);
  const { roads, rails, harbors } = await waySetsFor(db, matchId, p.id, await alliesOf(db, matchId, p.id));
  const route = findRoute(p.capitalRegionId, regionId, techs.has(balance.travel.seaTech), roads, rails, harbors);
  if (!route) throw httpError(400, "no route for the wagon");
  const now = matchNow(m);
  const seconds = travelSeconds(route, balance.capital.wagonSpeed, m.speed);
  const result = await db.transaction(async (tx) => {
    await requireRunning(tx, matchId);
    const ids = [p.capitalRegionId!, regionId].sort();
    const locked = new Map<string, Awaited<ReturnType<typeof settleAndLockRegion>>>();
    for (const id of ids) locked.set(id, await settleAndLockRegion(tx, matchId, id, now, m.speed, resourceMultOf(m)));
    const target = locked.get(regionId)!;
    const old = locked.get(p.capitalRegionId!)!;
    if (target.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    if (target.frozenAt) throw httpError(409, "a frozen region cannot be the capital");
    if (old.ownerPlayerId !== p.id) throw httpError(409, "you have lost your capital");
    // Load the wagon: food, wood, stone, then ore and horses, up to its capacity.
    const stock = stockOf(old);
    const cargo: Record<string, number> = {};
    let left = balance.capital.wagonCarry;
    for (const k of ["food", "wood", "stone", ...Object.keys(stock).filter((x) => !["food", "wood", "stone"].includes(x))]) {
      const take = Math.floor(Math.min(stock[k] ?? 0, left));
      if (take >= 1) {
        cargo[k] = take;
        left -= take;
      }
      if (left <= 0) break;
    }
    if (Object.keys(cargo).length) await applyCost(tx, old, cargo);
    const arrivesAt = new Date(now.getTime() + seconds * 1000);
    const [a] = await tx
      .insert(armies)
      .values({ matchId, playerId: p.id, mission: "relocate", originRegionId: p.capitalRegionId!, targetRegionId: regionId, units: {}, cargo, path: route.path, status: "outbound", departsAt: now, arrivesAt })
      .returning();
    await tx.insert(jobs).values({ matchId, playerId: p.id, regionId, kind: "mission", refId: a!.id, startsAt: now, endsAt: arrivesAt });
    return { armyId: a!.id, arrivesAt, cargo };
  });
  return { ...result, path: route.path };
}
