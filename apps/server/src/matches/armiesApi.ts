import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { balance, findRoute, sendArmyBody, travelSeconds } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matches, playerTechs, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { httpError, sendArmy, type CommandContext } from "../sim/commands.js";

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
