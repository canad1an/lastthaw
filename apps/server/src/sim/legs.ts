/**
 * One formula for every leg an army or convoy travels. Whatever sends units on their way (a command, a convoy's next
 * stop, the walk home, an evacuation) prices the leg here, so the player's roads, rails and harbours, their travel
 * techs and the weather on the path count on every leg, not only the first.
 */
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { armySpeed, balance, findRoute, haulFactor, isHaulerConvoy, techEffectsOf, travelSeconds, unitById, type Route, type UnitCounts } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matchRegions, playerTechs } from "../db/schema.js";
import { alliesOf } from "./alliances.js";
import { waySetsFor, type Tx } from "./regions.js";
import type { MatchRow } from "../worker/jobs.js";

/** What shapes a leg for one player: their techs and the ways (theirs and their allies') they may use. */
export interface LegContext {
  techs: ReadonlySet<string>;
  roads: ReadonlySet<string>;
  rails: ReadonlySet<string>;
  harbors: ReadonlySet<string>;
  /** Waystations: the share each region cuts from hauler legs ending there. */
  stations: ReadonlyMap<string, number>;
}

export async function legContextFor(db: Db | Tx, matchId: string, playerId: string): Promise<LegContext> {
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, playerId));
  const ways = await waySetsFor(db, matchId, playerId, await alliesOf(db, matchId, playerId));
  return { techs: new Set(techRows.map((t) => t.id)), ...ways };
}

/**
 * The route for this player between two regions, over their roads, rails and harbours. Sea legs are allowed when
 * they know the sea tech, or always when `allowSea` is given (a convoy coming home crossed somehow to get there).
 */
export function routeFor(ctx: LegContext, from: string, to: string, allowSea?: boolean): Route | null {
  return findRoute(from, to, allowSea ?? ctx.techs.has(balance.travel.seaTech), ctx.roads, ctx.rails, ctx.harbors);
}

/** A storm anywhere on the path slows the leg by the storm's travel factor. */
export async function stormOnPath(tx: Db | Tx, matchId: string, path: readonly string[], at: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, matchId), inArray(matchRegions.regionId, [...path]), gt(matchRegions.stormUntil, at)));
  return (row?.n ?? 0) > 0 ? balance.events.storm.travel : 1;
}

/**
 * Real seconds for `units` to cover `route` setting out at `at`: the slowest unit's pace (or `walking` when people
 * travel alone), the player's travel techs, the waystations along the way for a pure hauler convoy, and the weather.
 */
export async function legSeconds(tx: Db | Tx, m: MatchRow, ctx: LegContext, route: Route, units: UnitCounts, at: Date, walking = unitById.get("settler")?.speed ?? 4): Promise<number> {
  const moving = Object.values(units).some((n) => n > 0);
  const speed = (moving ? armySpeed(units) : walking) * (1 + techEffectsOf(ctx.techs).travel);
  const stations = isHaulerConvoy(units) ? haulFactor(route.path, ctx.stations) : 1;
  return travelSeconds(route, speed, m.speed) * stations * (await stormOnPath(tx, m.id, route.path, at));
}
