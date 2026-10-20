import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { advisorKind, advisorSettings } from "@lastthaw/shared";
import { idParams } from "./params.js";
import type { Db } from "../db/client.js";
import { advisors, matches, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { drawWage, regionsHeld, runPass, wageFor } from "../sim/advisors.js";
import { advisorTargetBody, balance, regionById } from "@lastthaw/shared";
import { matchRegions } from "../db/schema.js";
import { areAllied } from "../sim/alliances.js";

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

const kindParams = idParams.extend({ kind: advisorKind });

/**
 * Advisors: hire, set up, fire and prod the Economic advisor. No hiring fee: the first hour's wage is charged on
 * hiring and then every game hour by the tick; fire and rehire freely.
 */
export async function advisorRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  async function loadContext(matchId: string, userId: string) {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (m.status !== "running" || m.pausedAt) throw httpError(409, "the match is not running");
    const [p] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, userId))).limit(1);
    if (!p || p.eliminatedAt) throw httpError(403, "not a player in this match");
    return { m, p };
  }

  app.post("/api/matches/:id/advisors/:kind/hire", async (req) => {
    const user = requireUser(req);
    const { id: matchId, kind } = kindParams.parse(req.params);
    const { m, p } = await loadContext(matchId, user.id);
    const [existing] = await db.select({ id: advisors.id }).from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, kind))).limit(1);
    if (existing) throw httpError(409, "that advisor is already hired");
    const wage = wageFor(kind, await regionsHeld(db, m, p.id));
    const now = matchNow(m);
    await db.transaction(async (tx) => {
      if (!(await drawWage(tx, m, p, wage))) {
        const line = Object.entries(wage)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ");
        throw httpError(409, `you cannot pay the first hour's wage (${line}) from your regions`);
      }
      await tx.insert(advisors).values({ matchId, playerId: p.id, kind, hiredAt: now, paidUntil: new Date(now.getTime() + 3600_000 / m.speed), settings: advisorSettings.parse({}) });
    });
    await publisher.toPlayer(matchId, p.id, "advisor.hired", { kind });
    return { ok: true, wage };
  });

  app.post("/api/matches/:id/advisors/:kind/fire", async (req) => {
    const user = requireUser(req);
    const { id: matchId, kind } = kindParams.parse(req.params);
    const { p } = await loadContext(matchId, user.id);
    const gone = await db.delete(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, kind))).returning({ id: advisors.id });
    if (!gone.length) throw httpError(404, "no such advisor");
    await publisher.toPlayer(matchId, p.id, "advisor.fired", { kind });
    return { ok: true };
  });

  app.put("/api/matches/:id/advisors/:kind/settings", async (req) => {
    const user = requireUser(req);
    const { id: matchId, kind } = kindParams.parse(req.params);
    const { p } = await loadContext(matchId, user.id);
    const body = advisorSettings.parse(req.body);
    const updated = await db
      .update(advisors)
      .set({ settings: body })
      .where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, kind)))
      .returning({ id: advisors.id });
    if (!updated.length) throw httpError(404, "no such advisor");
    await publisher.toPlayer(matchId, p.id, "advisor.settings", { kind });
    return { ok: true, settings: body };
  });

  app.post("/api/matches/:id/advisors/:kind/run", async (req) => {
    const user = requireUser(req);
    const { id: matchId, kind } = kindParams.parse(req.params);
    const { m, p } = await loadContext(matchId, user.id);
    const [a] = await db.select().from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, kind))).limit(1);
    if (!a) throw httpError(404, "no such advisor");
    if (a.unpaidSince) throw httpError(409, "your advisor is unpaid and will not work until the wage is met");
    const now = matchNow(m);
    if (a.lastPassAt && now.getTime() - a.lastPassAt.getTime() < 60_000 / m.speed) throw httpError(429, "the advisor has just made a pass; give it a minute");
    const report = await runPass(db, m, p, a, now, publisher);
    return { ok: true, report };
  });


  /** Mark or unmark a region as a target for the Military advisor, from the map. */
  app.post("/api/matches/:id/advisors/military/targets", async (req) => {
    const user = requireUser(req);
    const { id: matchId } = idParams.parse(req.params);
    const { regionId, add } = advisorTargetBody.parse(req.body);
    const { m, p } = await loadContext(matchId, user.id);
    if (!regionById(regionId)) throw httpError(400, "unknown region");
    const [a] = await db.select().from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, "military"))).limit(1);
    if (!a) throw httpError(404, "no Military advisor");
    const settings = advisorSettings.parse(a.settings ?? {});
    let targets = settings.targets.filter((t) => t !== regionId);
    if (add) {
      const [row] = await db.select({ owner: matchRegions.ownerPlayerId, frozenAt: matchRegions.frozenAt }).from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId))).limit(1);
      if (row?.owner === p.id) throw httpError(400, "that region is already yours");
      if (row?.frozenAt) throw httpError(400, "that region is frozen");
      if (row?.owner && (await areAllied(db, matchId, p.id, row.owner))) throw httpError(400, "that region belongs to an ally");
      if (targets.length >= balance.advisors.military.maxTargets) throw httpError(400, `at most ${balance.advisors.military.maxTargets} targets at a time`);
      targets = [...targets, regionId];
    }
    await db.update(advisors).set({ settings: { ...settings, targets } }).where(eq(advisors.id, a.id));
    void m;
    await publisher.toPlayer(matchId, p.id, "advisor.targets", { targets });
    return { ok: true, targets };
  });
}
