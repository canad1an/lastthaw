import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  balance,
  buildBody,
  buildingById,
  buildingCost,
  buildingSeconds,
  canAfford,
  effectsOf,
  missingFor,
  realSeconds,
  researchBody,
  techById,
  techSeconds,
  trainBody,
  trainSeconds,
  unitById,
  unitCost,
  regionById,
  type Cost,
} from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { jobs, matches, playerTechs, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { applyCost, settleAndLockRegion, stockOf, type Tx } from "../sim/regions.js";

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** Pending (not completed, not cancelled) jobs for a region, in queue order. */
export async function pendingRegionJobs(tx: Tx | Db, matchId: string, regionId: string) {
  return tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.matchId, matchId), eq(jobs.regionId, regionId), isNull(jobs.completedAt), isNull(jobs.cancelledAt)))
    .orderBy(asc(jobs.startsAt), asc(jobs.id));
}

/** Build, train and research endpoints. Resources are paid when a job is queued. */
export async function jobRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
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

  app.post("/api/matches/:id/regions/:regionId/build", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const { buildingId } = buildBody.parse(req.body);
    const { m, p, techs } = await loadContext(matchId, user.id);
    const def = buildingById.get(buildingId);
    if (!def) throw httpError(400, "unknown building");
    if (def.age > p.age) throw httpError(400, `${def.name} needs the ${["Stone", "Bronze", "Iron", "Classical", "Medieval"][def.age]} Age`);
    if (def.requires && !techs.has(def.requires)) throw httpError(400, `${def.name} needs ${techById.get(def.requires)?.name ?? def.requires}`);

    const job = await db.transaction(async (tx) => {
      const now = matchNow(m);
      const row = await settleAndLockRegion(tx, matchId, regionId, now, m.speed);
      if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
      if (row.frozenAt) throw httpError(409, "this region is frozen");
      const pending = await pendingRegionJobs(tx, matchId, regionId);
      if (pending.length >= balance.queue.slotsPerRegion) throw httpError(409, "the build queue is full");
      const queuedLevels = pending.filter((j) => j.kind === "build" && j.refId === buildingId).length;
      const level = (row.buildings[buildingId] ?? 0) + queuedLevels + 1;
      if (level > def.maxLevel) throw httpError(400, `${def.name} is at its maximum level`);
      const cost = buildingCost(def, level);
      const stock = stockOf(row);
      if (!canAfford(stock, cost)) throw httpError(409, `not enough ${missingFor(stock, cost).join(", ")}`);
      await applyCost(tx, row, cost);
      const startsAt = pending.length ? pending[pending.length - 1]!.endsAt : now;
      const endsAt = new Date(startsAt.getTime() + realSeconds(buildingSeconds(def, level), 0, m.speed) * 1000);
      const [j] = await tx
        .insert(jobs)
        .values({ matchId, playerId: p.id, regionId, kind: "build", refId: buildingId, level, slot: pending.length, payload: { cost }, startsAt, endsAt })
        .returning();
      return j!;
    });
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId });
    return { ok: true, jobId: job.id, endsAt: job.endsAt.toISOString() };
  });

  app.post("/api/matches/:id/regions/:regionId/train", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const { unitId, qty } = trainBody.parse(req.body);
    const { m, p, techs } = await loadContext(matchId, user.id);
    const def = unitById.get(unitId);
    if (!def) throw httpError(400, "unknown unit");
    if (def.age > p.age) throw httpError(400, `${def.name} needs a later age`);
    if (def.requires && !techs.has(def.requires)) throw httpError(400, `${def.name} needs ${techById.get(def.requires)?.name ?? def.requires}`);
    const region = regionById(regionId);
    if (def.needsResource && !region?.resources.includes(def.needsResource)) throw httpError(400, `${def.name} can only be trained where there are ${def.needsResource}`);

    const job = await db.transaction(async (tx) => {
      const now = matchNow(m);
      const row = await settleAndLockRegion(tx, matchId, regionId, now, m.speed);
      if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
      if (row.frozenAt) throw httpError(409, "this region is frozen");
      const pending = await pendingRegionJobs(tx, matchId, regionId);
      if (pending.length >= balance.queue.slotsPerRegion) throw httpError(409, "the build queue is full");
      const queuedPeople = pending.filter((j) => j.kind === "train").reduce((a, j) => a + (j.qty ?? 0), 0);
      if (row.popWorkers - queuedPeople < qty) throw httpError(409, "not enough free workers to train that many");
      const cost: Cost = unitCost(def, qty);
      const stock = stockOf(row);
      if (!canAfford(stock, cost)) throw httpError(409, `not enough ${missingFor(stock, cost).join(", ")}`);
      await applyCost(tx, row, cost);
      const effects = effectsOf(row.buildings);
      const startsAt = pending.length ? pending[pending.length - 1]!.endsAt : now;
      const endsAt = new Date(startsAt.getTime() + realSeconds(trainSeconds(def, qty), effects.trainSpeed, m.speed) * 1000);
      const [j] = await tx
        .insert(jobs)
        .values({ matchId, playerId: p.id, regionId, kind: "train", refId: unitId, qty, slot: pending.length, payload: { cost }, startsAt, endsAt })
        .returning();
      return j!;
    });
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId });
    return { ok: true, jobId: job.id, endsAt: job.endsAt.toISOString() };
  });

  app.post("/api/matches/:id/research", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const { techId } = researchBody.parse(req.body);
    const { m, p, techs } = await loadContext(matchId, user.id);
    const def = techById.get(techId);
    if (!def) throw httpError(400, "unknown tech");
    if (techs.has(techId)) throw httpError(409, "already researched");
    if (def.age > p.age) throw httpError(400, `${def.name} needs a later age`);
    for (const r of def.requires ?? []) if (!techs.has(r)) throw httpError(400, `${def.name} needs ${techById.get(r)?.name ?? r}`);
    if (!p.capitalRegionId) throw httpError(409, "no capital");

    const job = await db.transaction(async (tx) => {
      const now = matchNow(m);
      const [current] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.playerId, p.id), eq(jobs.kind, "research"), isNull(jobs.completedAt), isNull(jobs.cancelledAt)))
        .limit(1);
      if (current) throw httpError(409, "research is already in progress");
      const capital = await settleAndLockRegion(tx, matchId, p.capitalRegionId!, now, m.speed);
      if (capital.ownerPlayerId !== p.id) throw httpError(409, "you have lost your capital");
      const stock = stockOf(capital);
      if (!canAfford(stock, def.cost)) throw httpError(409, `not enough ${missingFor(stock, def.cost).join(", ")} in your capital`);
      await applyCost(tx, capital, def.cost);
      const effects = effectsOf(capital.buildings);
      const endsAt = new Date(now.getTime() + realSeconds(techSeconds(def), effects.researchSpeed, m.speed) * 1000);
      const [j] = await tx
        .insert(jobs)
        .values({ matchId, playerId: p.id, regionId: null, kind: "research", refId: techId, payload: { cost: def.cost }, startsAt: now, endsAt })
        .returning();
      return j!;
    });
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: p.capitalRegionId });
    return { ok: true, jobId: job.id, endsAt: job.endsAt.toISOString() };
  });

  /** Cancel a pending job. Full refund if it has not started, partial once started. Later jobs shift earlier. */
  app.post("/api/matches/:id/jobs/:jobId/cancel", async (req) => {
    const user = requireUser(req);
    const { id: matchId, jobId } = req.params as { id: string; jobId: string };
    const { m, p } = await loadContext(matchId, user.id);
    await db.transaction(async (tx) => {
      const now = matchNow(m);
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
      if (!job || job.matchId !== matchId || job.playerId !== p.id) throw httpError(404, "job not found");
      if (job.completedAt || job.cancelledAt) throw httpError(409, "job already finished");
      if (!["build", "train", "research"].includes(job.kind)) throw httpError(400, "cannot cancel that");
      const refundRegion = job.regionId ?? p.capitalRegionId;
      const cost = ((job.payload as { cost?: Cost }).cost ?? {}) as Cost;
      const started = job.startsAt.getTime() <= now.getTime();
      const factor = started ? balance.timers.cancelRefundStarted : 1;
      if (refundRegion) {
        const row = await settleAndLockRegion(tx, matchId, refundRegion, now, m.speed);
        if (row.ownerPlayerId === p.id) await applyCost(tx, row, cost, -factor);
      }
      await tx.update(jobs).set({ cancelledAt: now }).where(eq(jobs.id, jobId));
      // Pull later jobs in the same region forward by this job's duration.
      if (job.regionId) {
        const later = (await pendingRegionJobs(tx, matchId, job.regionId)).filter((j) => j.startsAt.getTime() >= job.endsAt.getTime());
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

  // Keep sql import referenced for future raw queries.
  void sql;
}
