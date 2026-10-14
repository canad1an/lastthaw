import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { balance, findRoute, sendArmyBody, travelSeconds } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, jobs, matches, playerTechs, players } from "../db/schema.js";
import { matchNow } from "../sim/clock.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { httpError, sendArmy, type CommandContext } from "../sim/commands.js";
import { disbandUnits, evacuateRegion } from "../sim/evacuate.js";
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
    const { m, techs } = await loadContext(matchId, user.id);
    const route = findRoute(q.from, q.to, techs.has(balance.travel.seaTech));
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
