import { and, eq, inArray, sql } from "drizzle-orm";
import type pino from "pino";
import { AGES, buildingById, techById, unitById, balance } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { events, jobs, matchRegions, matches, messages, playerTechs, players, armies } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { settleAndLockRegion, type Tx } from "../sim/regions.js";
import { resolveMission, playBattleRound } from "../sim/missions.js";
import { applyIceStep } from "../sim/ice.js";
import { awardMilestone, finishMatch, winHoldExpired } from "../sim/endgame.js";
import { stormHits, mercenariesLeave } from "../sim/worldEvents.js";

export type JobRow = typeof jobs.$inferSelect;
export type MatchRow = typeof matches.$inferSelect;

const MAX_ATTEMPTS = 5;

/**
 * Complete every due job, strictly in ends_at order, each in its own
 * transaction. "Due" is measured on each match's own clock (with time skip).
 */
export async function runDueJobs(db: Db, publisher: Publisher, log: pino.Logger): Promise<number> {
  const due = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(matches, eq(matches.id, jobs.matchId))
    .where(
      sql`${jobs.completedAt} is null and ${jobs.cancelledAt} is null and ${jobs.attempts} < ${MAX_ATTEMPTS}
          and ${jobs.waitingFor} is null and ${matches.pausedAt} is null and ${matches.status} = 'running'
          and ${jobs.endsAt} <= now() + make_interval(secs => ${matches.clockOffsetSeconds})`,
    )
    // Same instant: the match end and win hold go last, so the final ice step and arrivals of that moment still resolve.
    .orderBy(jobs.endsAt, sql`case when ${jobs.kind} in ('match_end', 'win_hold') then 1 else 0 end`, jobs.id)
    .limit(500);

  let done = 0;
  for (const { id } of due) {
    const after: Array<() => Promise<void>> = [];
    try {
      await db.transaction(async (tx) => {
        const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).for("update", { skipLocked: true });
        if (!job || job.completedAt || job.cancelledAt) return;
        // NO KEY UPDATE: serialises with other match updates but not with the key-share locks that inserting jobs, armies or orders take through their foreign keys (FOR UPDATE deadlocked with those).
        const [m] = await tx.select().from(matches).where(eq(matches.id, job.matchId)).for("no key update");
        if (!m) return;
        await complete(tx, m, job, (fn) => after.push(fn));
        await tx.update(jobs).set({ completedAt: job.endsAt }).where(eq(jobs.id, id));
        done += 1;
      });
      for (const fn of after) await fn().catch(() => {});
    } catch (err) {
      // The transaction rolled back; record the failure separately so a poisoned job is retried a few times then parked.
      log.error({ err, jobId: id }, "job failed");
      await db
        .update(jobs)
        .set({ attempts: sql`${jobs.attempts} + 1`, lastError: String((err as Error).message ?? err).slice(0, 500) })
        .where(eq(jobs.id, id))
        .catch(() => {});
    }
  }
  return done;

  /** Dispatch by job kind. Publishing happens after commit via `after`. */
  async function complete(tx: Tx, m: MatchRow, job: JobRow, after: (fn: () => Promise<void>) => void): Promise<void> {
    switch (job.kind) {
      case "build":
        return completeBuild(tx, m, job, after);
      case "train":
        return completeTrain(tx, m, job, after);
      case "research":
        return completeResearch(tx, m, job, after);
      case "mission":
        return resolveMission(tx, m, job, publisher, after);
      case "ice_step":
        return applyIceStep(tx, m, job, publisher, after);
      case "win_hold":
        return winHoldExpired(tx, m, job, publisher, after);
      case "match_end":
        return finishMatch(tx, m, job.endsAt, publisher, after, null);
      case "storm":
        return stormHits(tx, m, job, publisher, after);
      case "merc_expire":
        return mercenariesLeave(tx, m, job);
      case "battle_round":
        return playBattleRound(tx, m, job, publisher, after);
      default:
        throw new Error(`no handler for job kind ${job.kind}`);
    }
  }

  async function completeBuild(tx: Tx, m: MatchRow, job: JobRow, after: (fn: () => Promise<void>) => void) {
    if (!job.regionId || !job.refId || !job.playerId) throw new Error("malformed build job");
    const def = buildingById.get(job.refId);
    if (!def) throw new Error(`unknown building ${job.refId}`);
    const row = await settleAndLockRegion(tx, m.id, job.regionId, job.endsAt, m.speed);
    // If the region changed hands while building, the new owner keeps the building.
    const level = Math.max(row.buildings[job.refId] ?? 0, job.level ?? 1);
    await tx
      .update(matchRegions)
      .set({ buildings: { ...row.buildings, [job.refId]: level } })
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, job.regionId)));
    await notify(tx, m.id, job.playerId, "build", `${def.name} level ${level} finished`, { regionId: job.regionId, buildingId: job.refId, level });
    const playerId = job.playerId;
    const regionId = job.regionId;
    if (level === 1 && (def.id === "harbor" || def.id === "temple")) await awardMilestone(tx, m, def.id, playerId, job.endsAt);
    after(() => publisher.toPlayer(m.id, playerId, "job.completed", { kind: "build", regionId, buildingId: job.refId, level }));
    if (def.wonder) {
      // The wonder stands: whoever owns the region at this moment has won the match.
      const owner = row.ownerPlayerId ?? playerId;
      const [w] = await tx.select({ name: players.name }).from(players).where(eq(players.id, owner)).limit(1);
      const everyone = await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, m.id), eq(players.isAi, false)));
      for (const other of everyone) await notify(tx, m.id, other.id, "system", `The ${def.name} is finished. ${w?.name ?? "Its builder"} has won the match.`, { regionId, wonder: true });
      await finishMatch(tx, m, job.endsAt, publisher, after, owner, "wonder");
    }
  }

  async function completeTrain(tx: Tx, m: MatchRow, job: JobRow, after: (fn: () => Promise<void>) => void) {
    if (!job.regionId || !job.refId || !job.playerId) throw new Error("malformed train job");
    const def = unitById.get(job.refId);
    if (!def) throw new Error(`unknown unit ${job.refId}`);
    const row = await settleAndLockRegion(tx, m.id, job.regionId, job.endsAt, m.speed);
    const wanted = job.qty ?? 0;
    const n = Math.max(0, Math.min(wanted, Math.floor(row.popWorkers)));
    await tx
      .update(matchRegions)
      .set({
        popWorkers: row.popWorkers - n,
        popSoldiers: row.popSoldiers + n,
        units: { ...row.units, [job.refId]: (row.units[job.refId] ?? 0) + n },
      })
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, job.regionId)));
    const subject = n < wanted ? `${n} of ${wanted} ${def.name} trained (not enough people)` : `${n} ${def.name} trained`;
    await notify(tx, m.id, job.playerId, "build", subject, { regionId: job.regionId, unitId: job.refId, qty: n });
    const playerId = job.playerId;
    const regionId = job.regionId;
    if (n > 0 && def.id === "train") await awardMilestone(tx, m, "train", playerId, job.endsAt);
    after(() => publisher.toPlayer(m.id, playerId, "job.completed", { kind: "train", regionId, unitId: job.refId, qty: n }));
  }

  async function completeResearch(tx: Tx, m: MatchRow, job: JobRow, after: (fn: () => Promise<void>) => void) {
    if (!job.refId || !job.playerId) throw new Error("malformed research job");
    const def = techById.get(job.refId);
    if (!def) throw new Error(`unknown tech ${job.refId}`);
    const playerId = job.playerId;
    await tx.insert(playerTechs).values({ matchId: m.id, playerId, techId: def.id, completedAt: job.endsAt }).onConflictDoNothing();
    await notify(tx, m.id, playerId, "research", `${def.name} researched`, { techId: def.id });
    const techIdDone = def.id;
    const fleet = balance.trade.fleetUpgradeTech[def.id];
    if (fleet) {
      await upgradeFleet(fleet.from, fleet.to);
      // Railways also sweeps up any caravans that were never rebuilt as wagons.
      if (def.id === "railways") await upgradeFleet("caravan", fleet.to);
    }
    async function upgradeFleet(fromId: string, toId: string) {
      const fleet = { from: fromId, to: toId };
      // Every caravan, stationed or on the road, becomes the better hauler.
      const regions = await tx
        .select({ regionId: matchRegions.regionId, units: matchRegions.units })
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId)))
        .orderBy(matchRegions.regionId);
      let converted = 0;
      for (const r of regions) {
        const n = r.units[fleet.from] ?? 0;
        if (n <= 0) continue;
        const units = { ...r.units, [fleet.from]: 0, [fleet.to]: (r.units[fleet.to] ?? 0) + n };
        await tx.update(matchRegions).set({ units }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
        converted += n;
      }
      const moving = await tx.select({ id: armies.id, units: armies.units }).from(armies).where(and(eq(armies.matchId, m.id), eq(armies.playerId, playerId), inArray(armies.status, ["outbound", "returning", "fighting"])));
      for (const a of moving) {
        const n = a.units[fleet.from] ?? 0;
        if (n <= 0) continue;
        await tx.update(armies).set({ units: { ...a.units, [fleet.from]: 0, [fleet.to]: (a.units[fleet.to] ?? 0) + n } }).where(eq(armies.id, a.id));
        converted += n;
      }
      if (converted) await notify(tx, m.id, playerId, "research", `${converted} ${unitById.get(fleet.from)?.name.toLowerCase() ?? fleet.from}${converted === 1 ? "" : "s"} rebuilt as ${unitById.get(fleet.to)?.name.toLowerCase() ?? fleet.to}s`, { techId: techIdDone, converted });
    }
    if (def.advancesTo !== undefined) {
      const [p] = await tx.select().from(players).where(eq(players.id, playerId)).for("update");
      if (p && p.age < def.advancesTo) {
        await tx.update(players).set({ age: def.advancesTo }).where(eq(players.id, playerId));
        const ageName = AGES[def.advancesTo];
        await tx.insert(events).values({ matchId: m.id, at: job.endsAt, kind: "age.advanced", payload: { playerId, age: def.advancesTo } });
        await awardMilestone(tx, m, `age_${def.advancesTo}`, playerId, job.endsAt);
        const everyone = await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, m.id), eq(players.isAi, false)));
        for (const other of everyone) {
          if (other.id === playerId) continue;
          await notify(tx, m.id, other.id, "system", `${p.name} has entered the ${ageName} Age`, { playerId, age: def.advancesTo });
        }
        after(() => publisher.toMatch(m.id, "age.advanced", { playerId, name: p.name, age: def.advancesTo }));
      }
    }
    after(() => publisher.toPlayer(m.id, playerId, "job.completed", { kind: "research", techId: def.id }));
  }
}

/** Insert a message-center entry for a player. */
export async function notify(tx: Tx, matchId: string, playerId: string, kind: string, subject: string, payload: unknown): Promise<void> {
  await tx.insert(messages).values({ matchId, playerId, kind, subject, payload: payload as Record<string, unknown> });
}
