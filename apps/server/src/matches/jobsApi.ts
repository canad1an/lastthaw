import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { balance, buildBody, researchBody, trainBody, type Cost } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { jobs, matches, matchRegions, playerTechs, players, tradeRoutes } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { recordSpend } from "../sim/ledger.js";
import { applyCost, settleAndLockRegion, resourceMultOf, type Tx } from "../sim/regions.js";
import { httpError, pendingRegionJobs, queueBuild, queueResearch, queueTrain, returnHeld, type CommandContext, type PlayerRow } from "../sim/commands.js";
import type { MatchRow } from "../worker/jobs.js";
import { advisors } from "../db/schema.js";
import { runPass, startedWork } from "../sim/advisors.js";

const cleanSlateBody = z.object({ routes: z.boolean().default(false) });
import { idParams, regionParams, jobParams } from "./params.js";

/** Cancel one pending job of the player's: refund it, put back what was set aside for it, pull later jobs forward. */
export async function cancelPendingJob(tx: Tx, m: MatchRow, p: PlayerRow, jobId: string): Promise<void> {
  const matchId = m.id;
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
          const held = { ...r.held };
          const back: Record<string, number> = {};
          for (const k of Object.keys(owed)) {
            if (!target[k] || owed[k]! <= 0) continue;
            const cut = Math.min(target[k]!, owed[k]!);
            target[k] = target[k]! - cut;
            owed[k] = owed[k]! - cut;
            if (target[k]! <= 0) delete target[k];
            // What was set aside for this job goes back on the shelf at the source.
            const give = Math.min(cut, held[k] ?? 0);
            if (give > 0) {
              held[k] = (held[k] ?? 0) - give;
              back[k] = give;
            }
          }
          if (Object.keys(back).length) {
            const src = await settleAndLockRegion(tx, matchId, r.fromRegionId, now, m.speed, resourceMultOf(m));
            if (src.ownerPlayerId === p.id) {
              await applyCost(tx, src, back as Cost, -1);
              await recordSpend(tx, m, p.id, job.kind === "train" ? "military" : "build", back, -1);
            }
          }
          const stillOwed = Object.entries(target).some(([k, v]) => v > (r.delivered[k] ?? 0) + 0.5);
          if (!stillOwed) await tx.delete(tradeRoutes).where(eq(tradeRoutes.id, r.id));
          else await tx.update(tradeRoutes).set({ target, load: target, held }).where(eq(tradeRoutes.id, r.id));
        }
      }
      const factor = started ? balance.timers.cancelRefundStarted : 1;
      if (refundRegion) {
        const row = await settleAndLockRegion(tx, matchId, refundRegion, now, m.speed, resourceMultOf(m));
        if (row.ownerPlayerId === p.id) {
          await applyCost(tx, row, cost, -factor);
          await recordSpend(tx, m, p.id, job.kind === "train" ? "military" : job.kind === "research" ? "research" : "build", cost, -factor);
        }
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
}

/**
 * A clean slate for the builder: every queued build is cancelled and refunded, every materials route is dropped with
 * its set-aside goods back on the shelf, and, when asked, the player's own trade routes go too. Training and research
 * are left alone. Returns what was cleared.
 */
export async function cleanSlate(tx: Tx, m: MatchRow, p: PlayerRow, ownRoutes: boolean): Promise<{ builds: number; routes: number }> {
  const pending = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, p.id), eq(jobs.kind, "build"), isNull(jobs.completedAt), isNull(jobs.cancelledAt)))
    .orderBy(desc(jobs.startsAt), desc(jobs.id));
  for (const j of pending) await cancelPendingJob(tx, m, p, j.id);
  const mine = await tx.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id))).orderBy(asc(matchRegions.regionId));
  let routes = 0;
  for (const r of mine) {
    const left = await tx.select({ id: tradeRoutes.id }).from(tradeRoutes).where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.toRegionId, r.regionId), sql`${tradeRoutes.forJobId} is not null`));
    if (!left.length) continue;
    routes += left.length;
    await returnHeld(tx, m, r.regionId);
  }
  if (ownRoutes) {
    const gone = await tx.delete(tradeRoutes).where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.playerId, p.id))).returning({ id: tradeRoutes.id });
    routes += gone.length;
  }
  return { builds: pending.length, routes };
}

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
    await db.transaction((tx) => cancelPendingJob(tx, m, p, jobId));
    await publisher.toPlayer(matchId, p.id, "region.updated", {});
    return { ok: true };
  });

  /** Clean slate: cancel every queued build, drop the materials routes (goods back on the shelf) and, if asked, the player's own routes. */
  app.post("/api/matches/:id/builds/clean-slate", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const { routes } = cleanSlateBody.parse(req.body ?? {});
    const { m, p } = await loadContext(matchId, user.id);
    const cleared = await db.transaction((tx) => cleanSlate(tx, m, p, routes));
    // The point of a clean slate is to redo the work now: a hired, paid Economic advisor makes a fresh pass at once.
    let passed = false;
    const [mara] = await db.select().from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, "economic"), isNull(advisors.firedAt))).limit(1);
    if (mara && !mara.unpaidSince && startedWork(mara)) {
      await runPass(db, m, p, mara, matchNow(m), publisher);
      passed = true;
    }
    await publisher.toPlayer(matchId, p.id, "region.updated", {});
    return { ok: true, ...cleared, passed };
  });
}
