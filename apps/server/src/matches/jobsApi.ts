import type { FastifyInstance } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { balance, buildBody, researchBody, trainBody, type Cost } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { jobs, matches, playerTechs, players, tradeRoutes } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { applyCost, settleAndLockRegion, resourceMultOf } from "../sim/regions.js";
import { httpError, pendingRegionJobs, queueBuild, queueResearch, queueTrain, type CommandContext } from "../sim/commands.js";
import { idParams, regionParams, jobParams } from "./params.js";

/** Build, train and research endpoints. Resources are paid when a job is queued. */
export async function jobRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  async function loadContext(matchId: string, userId: string): Promise<CommandContext> {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (m.status !== "running") throw httpError(409, "the match is not running");
    if (m.pausedAt) throw httpError(409, "the match is paused");
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
      .limit(1);
    if (!p) throw httpError(403, "not your match");
    const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
    return { db, m, p, techs: new Set(techRows.map((t) => t.id)) };
  }

  app.post("/api/matches/:id/regions/:regionId/build", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = regionParams.parse(req.params);
    const { buildingId } = buildBody.parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const job = await queueBuild(ctx, regionId, buildingId);
    await publisher.toPlayer(matchId, ctx.p.id, "region.updated", { regionId });
    return { ok: true, jobId: job.id, endsAt: job.endsAt.toISOString() };
  });

  app.post("/api/matches/:id/regions/:regionId/train", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = regionParams.parse(req.params);
    const { unitId, qty } = trainBody.parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const job = await queueTrain(ctx, regionId, unitId, qty);
    await publisher.toPlayer(matchId, ctx.p.id, "region.updated", { regionId });
    return { ok: true, jobId: job.id, endsAt: job.endsAt.toISOString() };
  });

  app.post("/api/matches/:id/research", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const { techId } = researchBody.parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const job = await queueResearch(ctx, techId);
    await publisher.toPlayer(matchId, ctx.p.id, "region.updated", { regionId: ctx.p.capitalRegionId });
    return { ok: true, jobId: job.id, endsAt: job.endsAt.toISOString() };
  });

  /** Cancel a pending job. Full refund if it has not started, partial once started. Later jobs shift earlier. */
  app.post("/api/matches/:id/jobs/:jobId/cancel", async (req) => {
    const user = requireUser(req);
    const { id: matchId, jobId } = jobParams.parse(req.params);
    const { m, p } = await loadContext(matchId, user.id);
    await db.transaction(async (tx) => {
      const now = matchNow(m);
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
      if (!job || job.matchId !== matchId || job.playerId !== p.id) throw httpError(404, "job not found");
      if (job.completedAt || job.cancelledAt) throw httpError(409, "job already finished");
      if (!["build", "train", "research"].includes(job.kind)) throw httpError(400, "cannot cancel that");
      const refundRegion = job.regionId ?? p.capitalRegionId;
      const payload = job.payload as { cost?: Cost; paid?: Record<string, number> };
      const cost = (payload.paid ?? payload.cost ?? {}) as Cost;
      const started = !job.waitingFor && job.startsAt.getTime() <= now.getTime();
      if (job.waitingFor && job.regionId) {
        // Take this job's share out of the materials routes heading here; drop a route once nothing is owed on it.
        const routes = await tx
          .select()
          .from(tradeRoutes)
          .where(and(eq(tradeRoutes.matchId, matchId), eq(tradeRoutes.toRegionId, job.regionId), sql`${tradeRoutes.forJobId} is not null`))
          .for("update");
        const owed: Record<string, number> = { ...(job.waitingFor as Record<string, number>) };
        for (const r of routes) {
          const target = { ...(r.target ?? {}) };
          for (const k of Object.keys(owed)) {
            if (!target[k] || owed[k]! <= 0) continue;
            const cut = Math.min(target[k]!, owed[k]!);
            target[k] = target[k]! - cut;
            owed[k] = owed[k]! - cut;
            if (target[k]! <= 0) delete target[k];
          }
          const stillOwed = Object.entries(target).some(([k, v]) => v > (r.delivered[k] ?? 0) + 0.5);
          if (!stillOwed) await tx.delete(tradeRoutes).where(eq(tradeRoutes.id, r.id));
          else await tx.update(tradeRoutes).set({ target, load: target }).where(eq(tradeRoutes.id, r.id));
        }
      }
      const factor = started ? balance.timers.cancelRefundStarted : 1;
      if (refundRegion) {
        const row = await settleAndLockRegion(tx, matchId, refundRegion, now, m.speed, resourceMultOf(m));
        if (row.ownerPlayerId === p.id) await applyCost(tx, row, cost, -factor);
      }
      await tx.update(jobs).set({ cancelledAt: now }).where(eq(jobs.id, jobId));
      {
        // Pull later jobs in the same queue (region, or the player's research queue) forward.
        const queue = job.regionId
          ? await pendingRegionJobs(tx, matchId, job.regionId)
          : await tx
              .select()
              .from(jobs)
              .where(and(eq(jobs.playerId, p.id), eq(jobs.kind, "research"), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
        const later = job.waitingFor ? [] : queue.filter((j) => j.id !== job.id && !j.waitingFor && j.startsAt.getTime() >= job.endsAt.getTime());
        const shift = job.endsAt.getTime() - Math.max(job.startsAt.getTime(), now.getTime());
        for (const l of later) {
          await tx
            .update(jobs)
            .set({ startsAt: new Date(l.startsAt.getTime() - shift), endsAt: new Date(l.endsAt.getTime() - shift) })
            .where(eq(jobs.id, l.id));
        }
      }
    });
    await publisher.toPlayer(matchId, p.id, "region.updated", {});
    return { ok: true };
  });
}
