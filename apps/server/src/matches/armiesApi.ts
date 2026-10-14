import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { balance, colonizeBody, findRoute, sendArmyBody, travelSeconds, setCapitalBody } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, jobs, matchRegions, matches, playerTechs, players, tradeRoutes } from "../db/schema.js";
import { matchNow } from "../sim/clock.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { httpError, sendArmy, type CommandContext } from "../sim/commands.js";
import { disbandUnits, evacuateRegion } from "../sim/evacuate.js";
import { roadSetFor, setCapital } from "../sim/regions.js";
import { alliesOf } from "../sim/alliances.js";
import { z } from "zod";

export async function armyRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  async function loadContext(matchId: string, userId: string): Promise<CommandContext> {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (m.status !== "running") throw httpError(409, "the match is not running");
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
      .limit(1);
    if (!p) throw httpError(403, "not your match");
    const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
    return { db, m, p, techs: new Set(techRows.map((t) => t.id)) };
  }

  /** Preview travel time without committing anything. */
  app.get("/api/matches/:id/route", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const q = req.query as { from?: string; to?: string; speed?: string };
    if (!q.from || !q.to) throw httpError(400, "from and to are required");
    const { m, p, techs } = await loadContext(matchId, user.id);
    const roads = await roadSetFor(db, m.id, p.id, await alliesOf(db, m.id, p.id));
    const route = findRoute(q.from, q.to, techs.has(balance.travel.seaTech), roads);
    if (!route) throw httpError(400, techs.has(balance.travel.seaTech) ? "no route" : "no land route; Shipbuilding allows sea crossings");
    const speed = Number(q.speed ?? 5) || 5;
    return { path: route.path, seconds: travelSeconds(route, speed, m.speed), usesSea: route.usesSea };
  });

  /** Evacuate a region: everyone and every unit moves to another of your regions with as much stock as they can carry. */
  app.post("/api/matches/:id/regions/:regionId/evacuate", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const { toRegionId } = z.object({ toRegionId: z.string() }).parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const r = await evacuateRegion(ctx, regionId, toRegionId);
    await publisher.toPlayer(matchId, ctx.p.id, "army.sent", { armyId: r.army.id, evacuated: regionId });
    return { ok: true, armyId: r.army.id, arrivesAt: r.army.arrivesAt.toISOString(), people: r.people, units: r.units, cargo: r.cargo, leftBehind: r.leftBehind };
  });

  /**
   * Colonize an empty region with settlers from this region. With `stock`, a
   * temporary caravan route is created that delivers those totals once the
   * colony is founded, then removes itself. Needs caravans at the source.
   */
  app.post("/api/matches/:id/regions/:regionId/colonize", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const body = colonizeBody.parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const stock = Object.fromEntries(Object.entries(body.stock ?? {}).filter(([, v]) => v >= 1).map(([k, v]) => [k, Math.floor(v)]));
    const wantsStock = Object.keys(stock).length > 0;
    if (wantsStock) {
      const [origin] = await db
        .select({ units: matchRegions.units })
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId)))
        .limit(1);
      if (((origin?.units as Record<string, number>)?.caravan ?? 0) < 1) throw httpError(400, "stocking the colony needs at least one caravan in this region");
    }
    const r = await sendArmy(ctx, regionId, { mission: "settle", targetRegionId: body.targetRegionId, units: { settler: body.settlers }, people: 0, cargo: {} });
    let routeId: string | null = null;
    if (wantsStock) {
      const [route] = await db
        .insert(tradeRoutes)
        .values({
          matchId,
          playerId: ctx.p.id,
          fromRegionId: regionId,
          toRegionId: body.targetRegionId,
          mode: "fixed",
          load: stock,
          share: 0,
          caravans: body.caravans,
          everyHours: 1,
          target: stock,
          delivered: {},
          nextAt: r.army.arrivesAt,
        })
        .returning({ id: tradeRoutes.id });
      routeId = route!.id;
    }
    await publisher.toPlayer(matchId, ctx.p.id, "army.sent", { armyId: r.army.id });
    return { ok: true, armyId: r.army.id, arrivesAt: r.army.arrivesAt.toISOString(), routeId };
  });

  /** Move the capital to another region you own. Research is paid from here, overflow caravans deliver here, loyalty is measured from here. */
  app.post("/api/matches/:id/capital", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const { regionId } = setCapitalBody.parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ owner: matchRegions.ownerPlayerId, frozenAt: matchRegions.frozenAt })
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId)))
        .for("update");
      if (row?.owner !== ctx.p.id) throw httpError(403, "not your region");
      if (row.frozenAt) throw httpError(409, "a frozen region cannot be the capital");
      if (ctx.p.capitalRegionId === regionId) throw httpError(409, "this is already your capital");
      await setCapital(tx, matchId, ctx.p.id, regionId);
    });
    await publisher.toPlayer(matchId, ctx.p.id, "region.updated", { regionId });
    return { ok: true, capitalRegionId: regionId };
  });

  /** Disband stationed units: they rejoin the region's workers. */
  app.post("/api/matches/:id/regions/:regionId/disband", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const { units } = z.object({ units: z.record(z.string(), z.number().int().min(0)) }).parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const r = await disbandUnits(ctx, regionId, units);
    await publisher.toPlayer(matchId, ctx.p.id, "region.updated", { regionId });
    return { ok: true, disbanded: r.disbanded };
  });

  /** Turn an outbound army around. It walks home over the time it has already spent travelling. */
  app.post("/api/matches/:id/armies/:armyId/recall", async (req) => {
    const user = requireUser(req);
    const { id: matchId, armyId } = req.params as { id: string; armyId: string };
    const { m, p } = await loadContext(matchId, user.id);
    const result = await db.transaction(async (tx) => {
      const [army] = await tx.select().from(armies).where(eq(armies.id, armyId)).for("update");
      if (!army || army.matchId !== matchId || army.playerId !== p.id) throw httpError(404, "army not found");
      if (army.status !== "outbound") throw httpError(409, "that army is already on its way back");
      const now = matchNow(m);
      const travelled = Math.max(1000, now.getTime() - army.departsAt.getTime());
      const returnsAt = new Date(now.getTime() + travelled);
      await tx
        .update(jobs)
        .set({ cancelledAt: now })
        .where(and(eq(jobs.matchId, matchId), eq(jobs.kind, "mission"), eq(jobs.refId, army.id), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
      await tx.update(armies).set({ status: "returning", returnsAt }).where(eq(armies.id, army.id));
      await tx.insert(jobs).values({ matchId, playerId: p.id, regionId: army.originRegionId, kind: "mission", refId: army.id, startsAt: now, endsAt: returnsAt });
      return { returnsAt, targetOwner: army.targetRegionId };
    });
    await publisher.toPlayer(matchId, p.id, "army.sent", { armyId, recalled: true });
    await publisher.toMatch(matchId, "region.updated", { regionId: result.targetOwner });
    return { ok: true, returnsAt: result.returnsAt.toISOString() };
  });

  app.post("/api/matches/:id/regions/:regionId/send", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const body = sendArmyBody.parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const { army, targetOwner, route } = await sendArmy(ctx, regionId, body);
    await publisher.toPlayer(matchId, ctx.p.id, "army.sent", { armyId: army.id });
    if (targetOwner && (body.mission === "raid" || body.mission === "conquer")) {
      await publisher.toPlayer(matchId, targetOwner, "army.incoming", { targetRegionId: body.targetRegionId, arrivesAt: army.arrivesAt.toISOString() });
    }
    return { ok: true, armyId: army.id, arrivesAt: army.arrivesAt.toISOString(), path: route.path };
  });
}
