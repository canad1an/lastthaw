import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { balance, createRouteBody, regionById } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, matchRegions, matches, players, tradeRoutes } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { httpError } from "../sim/commands.js";
import { areAllied } from "../sim/alliances.js";
import { dispatchRoute } from "../sim/trade.js";

/** Automated caravan routes between a player's regions (or to an ally's). */
export async function tradeRouteRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  async function ctx(matchId: string, userId: string) {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
      .limit(1);
    if (!p) throw httpError(403, "not your match");
    return { m, p };
  }

  app.post("/api/matches/:id/regions/:regionId/routes", async (req, reply) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const body = createRouteBody.parse(req.body);
    const { m, p } = await ctx(matchId, user.id);
    if (m.status !== "running") throw httpError(409, "the match is not running");
    if (!regionById(body.toRegionId)) throw httpError(400, "unknown destination");
    if (body.toRegionId === regionId) throw httpError(400, "a route needs two different regions");
    const [origin] = await db
      .select({ owner: matchRegions.ownerPlayerId })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId)))
      .limit(1);
    if (origin?.owner !== p.id) throw httpError(403, "not your region");
    const [dest] = await db
      .select({ owner: matchRegions.ownerPlayerId })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, body.toRegionId)))
      .limit(1);
    const target = body.target ? Object.fromEntries(Object.entries(body.target).filter(([, v]) => v >= 1).map(([k, v]) => [k, Math.floor(v)])) : null;
    if (target && Object.keys(target).length === 0) throw httpError(400, "choose totals to deliver");
    let friendly = dest?.owner === p.id || (dest?.owner ? await areAllied(db, matchId, p.id, dest.owner) : false);
    if (!friendly && target && !dest?.owner) {
      // Stock-up may be set up while settlers are still on the road.
      const settling = await db
        .select({ id: armies.id })
        .from(armies)
        .where(and(eq(armies.matchId, matchId), eq(armies.playerId, p.id), eq(armies.targetRegionId, body.toRegionId), eq(armies.mission, "settle"), eq(armies.status, "outbound")))
        .limit(1);
      friendly = settling.length > 0;
    }
    if (!friendly) throw httpError(400, "the destination must be yours, an ally's, or a region your settlers are heading to");
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tradeRoutes)
      .where(and(eq(tradeRoutes.matchId, matchId), eq(tradeRoutes.fromRegionId, regionId)));
    if ((count?.n ?? 0) >= balance.trade.maxRoutesPerRegion) throw httpError(409, `at most ${balance.trade.maxRoutesPerRegion} routes per region`);
    if (!target && body.mode === "share" && body.share <= 0) throw httpError(400, "share must be above 0%");
    if (!target && body.mode === "fixed" && !Object.values(body.load).some((v) => v > 0)) throw httpError(400, "choose something to carry");
    const [r] = await db
      .insert(tradeRoutes)
      .values({
        matchId,
        playerId: p.id,
        fromRegionId: regionId,
        toRegionId: body.toRegionId,
        mode: target ? "fixed" : body.mode,
        load: target ?? body.load,
        share: target ? 0 : Math.min(balance.tribute.maxShare, body.share),
        caravans: body.caravans,
        everyHours: target ? 1 : body.everyHours,
        target,
        delivered: {},
        nextAt: matchNow(m),
      })
      .returning();
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId });
    return reply.code(201).send({ id: r!.id });
  });

  /** Edit a route's destination, load, caravans or schedule. */
  app.patch("/api/matches/:id/routes/:routeId", async (req) => {
    const user = requireUser(req);
    const { id: matchId, routeId } = req.params as { id: string; routeId: string };
    const body = createRouteBody.parse(req.body);
    const { m, p } = await ctx(matchId, user.id);
    const [r] = await db.select().from(tradeRoutes).where(and(eq(tradeRoutes.id, routeId), eq(tradeRoutes.playerId, p.id))).limit(1);
    if (!r) throw httpError(404, "route not found");
    if (!regionById(body.toRegionId)) throw httpError(400, "unknown destination");
    if (body.toRegionId === r.fromRegionId) throw httpError(400, "a route needs two different regions");
    const [dest] = await db
      .select({ owner: matchRegions.ownerPlayerId })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, body.toRegionId)))
      .limit(1);
    const friendly = dest?.owner === p.id || (dest?.owner ? await areAllied(db, matchId, p.id, dest.owner) : false);
    if (!friendly) throw httpError(400, "the destination must be yours or an ally's");
    if (body.mode === "share" && body.share <= 0) throw httpError(400, "share must be above 0%");
    if (body.mode === "fixed" && !Object.values(body.load).some((v) => v > 0)) throw httpError(400, "choose something to carry");
    await db
      .update(tradeRoutes)
      .set({
        toRegionId: body.toRegionId,
        mode: body.mode,
        load: body.load,
        share: Math.min(balance.tribute.maxShare, body.share),
        caravans: body.caravans,
        everyHours: body.everyHours,
        nextAt: new Date(Math.min(r.nextAt.getTime(), matchNow(m).getTime() + (body.everyHours * 3600 * 1000) / m.speed)),
      })
      .where(eq(tradeRoutes.id, routeId));
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: r.fromRegionId });
    return { ok: true };
  });

  app.post("/api/matches/:id/routes/:routeId/toggle", async (req) => {
    const user = requireUser(req);
    const { id: matchId, routeId } = req.params as { id: string; routeId: string };
    const { p } = await ctx(matchId, user.id);
    const [r] = await db.select().from(tradeRoutes).where(and(eq(tradeRoutes.id, routeId), eq(tradeRoutes.playerId, p.id))).limit(1);
    if (!r) throw httpError(404, "route not found");
    await db.update(tradeRoutes).set({ enabled: !r.enabled }).where(eq(tradeRoutes.id, routeId));
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: r.fromRegionId });
    return { ok: true, enabled: !r.enabled };
  });

  app.delete("/api/matches/:id/routes/:routeId", async (req) => {
    const user = requireUser(req);
    const { id: matchId, routeId } = req.params as { id: string; routeId: string };
    const { p } = await ctx(matchId, user.id);
    const deleted = await db.delete(tradeRoutes).where(and(eq(tradeRoutes.id, routeId), eq(tradeRoutes.playerId, p.id))).returning({ from: tradeRoutes.fromRegionId });
    if (!deleted.length) throw httpError(404, "route not found");
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: deleted[0]!.from });
    return { ok: true };
  });

  /** Dispatch a route right now (also resets its schedule). */
  app.post("/api/matches/:id/routes/:routeId/run", async (req) => {
    const user = requireUser(req);
    const { id: matchId, routeId } = req.params as { id: string; routeId: string };
    const { m, p } = await ctx(matchId, user.id);
    if (m.status !== "running") throw httpError(409, "the match is not running");
    const [r] = await db.select().from(tradeRoutes).where(and(eq(tradeRoutes.id, routeId), eq(tradeRoutes.playerId, p.id))).limit(1);
    if (!r) throw httpError(404, "route not found");
    const now = matchNow(m);
    const result = await dispatchRoute(db, m, p, r, now);
    await db
      .update(tradeRoutes)
      .set({ lastResult: result, lastRunAt: now, nextAt: new Date(now.getTime() + (r.everyHours * 3600 * 1000) / m.speed) })
      .where(eq(tradeRoutes.id, routeId));
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: r.fromRegionId });
    return { ok: true, result };
  });
}
