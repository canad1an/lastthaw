import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { armySpeed, balance, findRoute, regionById, sendArmyBody, travelSeconds, type MissionKind } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, jobs, matchRegions, matches, playerTechs, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { applyCost, settleAndLockRegion, stockOf } from "../sim/regions.js";
import { areAllied } from "../sim/alliances.js";

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

const HOSTILE: ReadonlySet<MissionKind> = new Set(["raid", "conquer"]);

export async function armyRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  async function loadContext(matchId: string, userId: string) {
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
    return { m, p, techs: new Set(techRows.map((t) => t.id)) };
  }

  /** Preview travel time without committing anything. */
  app.get("/api/matches/:id/route", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const q = req.query as { from?: string; to?: string; speed?: string };
    if (!q.from || !q.to) throw httpError(400, "from and to are required");
    const { m, techs } = await loadContext(matchId, user.id);
    const route = findRoute(q.from, q.to, techs.has(balance.travel.seaTech));
    if (!route) throw httpError(400, "no route");
    const speed = Number(q.speed ?? 5) || 5;
    return { path: route.path, seconds: travelSeconds(route, speed, m.speed), usesSea: route.usesSea };
  });

  app.post("/api/matches/:id/regions/:regionId/send", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const body = sendArmyBody.parse(req.body);
    const { m, p, techs } = await loadContext(matchId, user.id);
    if (!regionById(body.targetRegionId)) throw httpError(400, "unknown target");
    if (body.targetRegionId === regionId) throw httpError(400, "the army is already there");
    const units = Object.fromEntries(Object.entries(body.units).filter(([, n]) => n > 0));
    const unitCount = Object.values(units).reduce((a, b) => a + b, 0);
    if (unitCount === 0 && body.mission !== "transport") throw httpError(400, "send at least one unit");
    if (body.mission === "conquer" && body.people < balance.conquest.occupiersRequired) {
      throw httpError(400, `conquering needs at least ${balance.conquest.occupiersRequired} people to occupy the region`);
    }

    const route = findRoute(regionId, body.targetRegionId, techs.has(balance.travel.seaTech));
    if (!route) throw httpError(400, techs.has(balance.travel.seaTech) ? "no route to that region" : "no land route; research Shipbuilding to cross the sea");
    const speed = unitCount ? armySpeed(units) : 5;
    const seconds = travelSeconds(route, speed, m.speed);

    const now = matchNow(m);
    const army = await db.transaction(async (tx) => {
      const origin = await settleAndLockRegion(tx, matchId, regionId, now, m.speed);
      if (origin.ownerPlayerId !== p.id) throw httpError(403, "not your region");

      // Target checks for friendly missions and for protection.
      const [target] = await tx
        .select()
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, body.targetRegionId)))
        .limit(1);
      const targetOwner = target?.ownerPlayerId ?? null;
      const friendly = targetOwner === p.id || (targetOwner ? await areAllied(tx, matchId, p.id, targetOwner) : false);
      if ((body.mission === "reinforce" || body.mission === "move" || body.mission === "transport") && !friendly) {
        throw httpError(400, "that region is not yours or an ally's");
      }
      if (HOSTILE.has(body.mission)) {
        if (friendly) throw httpError(400, "you cannot attack your own or allied regions");
        if (targetOwner) {
          const [owner] = await tx.select().from(players).where(eq(players.id, targetOwner)).limit(1);
          if (owner?.protectionUntil && owner.protectionUntil.getTime() > now.getTime()) {
            throw httpError(400, `${owner.name} is under beginner protection`);
          }
          if (p.protectionUntil && p.protectionUntil.getTime() > now.getTime()) {
            // Attacking another player forfeits your own protection.
            await tx.update(players).set({ protectionUntil: now }).where(eq(players.id, p.id));
          }
        }
      }

      // Take units, people and cargo out of the origin region.
      for (const [id, n] of Object.entries(units)) {
        if ((origin.units[id] ?? 0) < n) throw httpError(409, `not enough ${id} here`);
      }
      if (origin.popWorkers < body.people) throw httpError(409, "not enough free people here");
      const stock = stockOf(origin);
      for (const [k, v] of Object.entries(body.cargo)) {
        if (!(k in stock)) throw httpError(400, `unknown cargo ${k}`);
        if ((stock[k] ?? 0) < v) throw httpError(409, `not enough ${k} here`);
      }
      const newUnits = { ...origin.units };
      for (const [id, n] of Object.entries(units)) newUnits[id] = (newUnits[id] ?? 0) - n;
      await tx
        .update(matchRegions)
        .set({ units: newUnits, popSoldiers: origin.popSoldiers - unitCount, popWorkers: origin.popWorkers - body.people })
        .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId)));
      if (Object.keys(body.cargo).length) await applyCost(tx, { ...origin, popSoldiers: origin.popSoldiers - unitCount }, body.cargo);

      const arrivesAt = new Date(now.getTime() + seconds * 1000);
      const [a] = await tx
        .insert(armies)
        .values({
          matchId,
          playerId: p.id,
          mission: body.mission,
          originRegionId: regionId,
          targetRegionId: body.targetRegionId,
          units,
          cargo: { ...body.cargo, people: body.people },
          path: route.path,
          status: "outbound",
          departsAt: now,
          arrivesAt,
        })
        .returning();
      await tx.insert(jobs).values({ matchId, playerId: p.id, regionId: body.targetRegionId, kind: "mission", refId: a!.id, startsAt: now, endsAt: arrivesAt });
      return { army: a!, targetOwner };
    });

    await publisher.toPlayer(matchId, p.id, "army.sent", { armyId: army.army.id });
    if (army.targetOwner && HOSTILE.has(body.mission)) {
      await publisher.toPlayer(matchId, army.targetOwner, "army.incoming", { targetRegionId: body.targetRegionId, arrivesAt: army.army.arrivesAt.toISOString() });
    }
    return { ok: true, armyId: army.army.id, arrivesAt: army.army.arrivesAt.toISOString(), path: route.path };
  });
}
