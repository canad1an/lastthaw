import { and, eq, lte, sql } from "drizzle-orm";
import type pino from "pino";
import { carryCapacity, unitById } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matchRegions, matches, playerTechs, players, tradeRoutes } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "./clock.js";
import { projectRegion, stockOf } from "./regions.js";
import { sendArmy, type CommandContext } from "./commands.js";
import type { MatchRow } from "../worker/jobs.js";

export type TradeRouteRow = typeof tradeRoutes.$inferSelect;
type PlayerRow = typeof players.$inferSelect;

const GOODS = ["food", "wood", "stone", "copper", "tin", "iron", "horses"] as const;

/**
 * Trade route dispatcher (worker loop). Every due route loads caravans at its
 * origin and sends them as a transport mission; they unload and walk back.
 */
export async function runTradeRoutes(db: Db, publisher: Publisher, log: pino.Logger): Promise<number> {
  const due = await db
    .select({ route: tradeRoutes, m: matches })
    .from(tradeRoutes)
    .innerJoin(matches, eq(matches.id, tradeRoutes.matchId))
    .where(and(eq(matches.status, "running"), eq(tradeRoutes.enabled, true), lte(tradeRoutes.nextAt, sql`now() + make_interval(secs => ${matches.clockOffsetSeconds})`)))
    .limit(200);
  let sent = 0;
  for (const { route, m } of due) {
    const now = matchNow(m);
    try {
      const [p] = await db.select().from(players).where(eq(players.id, route.playerId)).limit(1);
      if (!p) continue;
      const result = await dispatchRoute(db, m, p, route, now);
      if (result.startsWith("sent")) {
        sent += 1;
        await publisher.toPlayer(m.id, p.id, "army.sent", { routeId: route.id });
      }
      await db
        .update(tradeRoutes)
        .set({ lastResult: result, lastRunAt: now, nextAt: new Date(now.getTime() + (route.everyHours * 3600 * 1000) / m.speed) })
        .where(eq(tradeRoutes.id, route.id));
    } catch (err) {
      log.warn({ err, routeId: route.id }, "trade route failed");
      await db
        .update(tradeRoutes)
        .set({ lastResult: `error: ${(err as Error).message}`, lastRunAt: now, nextAt: new Date(now.getTime() + (route.everyHours * 3600 * 1000) / m.speed) })
        .where(eq(tradeRoutes.id, route.id));
    }
  }
  return sent;
}

/** Load caravans at the origin according to the route and send them. Returns a human-readable result. */
export async function dispatchRoute(db: Db, m: MatchRow, p: PlayerRow, route: TradeRouteRow, now: Date): Promise<string> {
  const [origin] = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, route.fromRegionId)))
    .limit(1);
  if (!origin || origin.ownerPlayerId !== p.id) return "origin region is no longer yours";
  if (origin.frozenAt) return "origin region is frozen";
  const home = origin.units.caravan ?? 0;
  if (home <= 0) return "no caravans at home (they may be on the road)";
  const perCaravan = unitById.get("caravan")?.carry ?? 500;
  const n = Math.min(route.caravans, home);
  const capacity = n * perCaravan;

  const { economy, rates } = projectRegion(origin, now, m.speed);
  const stock = stockOf({ ...origin, food: economy.food, wood: economy.wood, stone: economy.stone, special: economy.special });
  const cargo: Record<string, number> = {};
  if (route.mode === "share") {
    for (const res of ["food", "wood", "stone"] as const) {
      const want = Math.max(0, rates.gross[res] * route.everyHours * route.share);
      const amt = Math.min(want, stock[res] ?? 0);
      if (amt >= 1) cargo[res] = Math.floor(amt);
    }
  } else {
    for (const res of GOODS) {
      const want = route.load[res] ?? 0;
      const amt = Math.min(want, stock[res] ?? 0);
      if (amt >= 1) cargo[res] = Math.floor(amt);
    }
  }
  let total = Object.values(cargo).reduce((a, b) => a + b, 0);
  if (total < 1) return "nothing to send (stock empty)";
  if (total > capacity) {
    const f = capacity / total;
    for (const k of Object.keys(cargo)) cargo[k] = Math.floor(cargo[k]! * f);
    total = Object.values(cargo).reduce((a, b) => a + b, 0);
  }
  const caravans = Math.max(1, Math.min(n, Math.ceil(total / perCaravan)));
  if (carryCapacity({ caravan: caravans }) < total) return "caravans cannot carry that much";

  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
  const ctx: CommandContext = { db, m, p, techs: new Set(techRows.map((t) => t.id)) };
  await sendArmy(ctx, route.fromRegionId, { mission: "transport", targetRegionId: route.toRegionId, units: { caravan: caravans }, people: 0, cargo });
  const desc = Object.entries(cargo)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  return `sent ${caravans} caravan${caravans === 1 ? "" : "s"} with ${desc}`;
}
