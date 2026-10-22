import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { enterMap, enterMatchMap, mapOf } from "../map/scope.js";
import { tribesChat, tribesSpeak } from "./tribeVoice.js";
import { placeBounty } from "./objectives.js";
import type pino from "pino";
import { balance, distanceKm, effectsOf, regionById, seededRng, applyTechEffects, type TechEffects } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matchRegions, matches, players } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "./clock.js";
import { chargeAdvisors, overflowPlayerIds } from "./advisors.js";
import { recordEconomy } from "./ledger.js";
import { ownerTechEffects, settleAndLockRegion, type Tx } from "./regions.js";
import { migrateCrowded, sweepEvacuated } from "./missions.js";
import { repairWaitingBuilds } from "./commands.js";
import { handleRegionLost } from "./missions.js";
import { checkEarlyWin, recordOwnershipFrame, updateScores } from "./endgame.js";
import { notify, type MatchRow } from "../worker/jobs.js";
import { runAiPlayer } from "./ai.js";
import { runDailyEvents } from "./worldEvents.js";
import { expirePacts } from "./diplomacy.js";
import { dissolveAlliances } from "./alliances.js";

/**
 * Periodic per-match tick: loyalty drift and rebellions on occupied regions,
 * neutral tribes growing, score update, early-win check, then AI decisions.
 * Runs when at least `balance.tick.minutes` of match time passed since the last one.
 */
export async function runMatchTicks(db: Db, publisher: Publisher, log: pino.Logger): Promise<void> {
  const due = await db
    .select({ id: matches.id })
    .from(matches)
    .where(
      and(
        eq(matches.status, "running"),
        isNull(matches.pausedAt),
        or(isNull(matches.lastTickAt), lte(matches.lastTickAt, sql`now() + make_interval(secs => ${matches.clockOffsetSeconds}) - make_interval(secs => greatest(${balance.tick.minSeconds}, ${balance.tick.minutes * 60}::float / greatest(1, ${matches.speed})))`)),
      ),
    );
  for (const { id } of due) {
    await enterMatchMap(db, id);
    try {
      await tickMatch(db, publisher, id, log);
    } catch (err) {
      log.error({ err, matchId: id }, "tick failed");
    }
  }
}

async function tickMatch(db: Db, publisher: Publisher, matchId: string, log: pino.Logger): Promise<void> {
  const after: Array<() => Promise<void>> = [];
  const m = await db.transaction(async (tx) => {
    const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("no key update", { skipLocked: true });
    if (!m || m.status !== "running") return null;
    const now = matchNow(m);
    const last = m.lastTickAt ?? m.startsAt;
    const elapsedGameHours = Math.min(48, (Math.max(0, now.getTime() - last.getTime()) / 3600_000) * m.speed);
    const rng = seededRng(`${m.seed}:tick:${now.getTime()}`);

    // Loyalty first: it locks every owned region in ascending order; the passes below re-lock rows already held.
    await loyaltyAndRebellion(tx, m, now, elapsedGameHours, rng, (fn) => after.push(fn), publisher);
    await sweepEvacuated(tx, m, now);
    // People spill over from crowded regions only for AI tribes and for humans whose Economic advisor is paid and set to overflow.
    await migrateCrowded(tx, m, now, elapsedGameHours, await overflowPlayerIds(tx, m));
    await repairWaitingBuilds(tx, m, now);
    await chargeAdvisors(tx, m, now);
    await neutralGrowth(tx, m, now, elapsedGameHours);
    // Once per match day: blizzards, plague, rich finds and the hordes.
    const dayNow = Math.floor(((now.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed);
    const dayBefore = Math.floor(((last.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed);
    // A fast match (or a long gap between ticks) can cross several day lines at once: every day gets its events.
    for (let d = Math.max(1, dayBefore + 1); d <= dayNow; d++) {
      await runDailyEvents(tx, m, now, d, seededRng(`${m.seed}:day:${d}`), publisher, (fn) => after.push(fn));
      // Alliances are temporary: they all end on the same morning, and the last days are every tribe for itself.
      if (d === balance.match.alliancesEndDay) await dissolveAlliances(tx, m, now, publisher, (fn) => after.push(fn));
      await tribesSpeak(tx, m, d, (fn) => after.push(fn));
      await tribesChat(tx, m, d, now, publisher, (fn) => after.push(fn));
    }
    await expirePacts(tx, m, now);
    const standings = await updateScores(tx, m);
    await recordEconomy(tx, m, now);
    await recordOwnershipFrame(tx, m, now);
    await checkEarlyWin(tx, m, now, standings, publisher, (fn) => after.push(fn));
    await tx.update(matches).set({ lastTickAt: now }).where(eq(matches.id, m.id));
    return m;
  });
  for (const fn of after) await fn().catch(() => {});
}

/**
 * AI decisions, run by the separate `ai` process so they can never delay
 * job completion or the tick. Each command commits on its own.
 */
export async function runAiDecisions(db: Db, publisher: Publisher, log: pino.Logger, limit = Number(process.env.AI_PASS_LIMIT) || 25): Promise<number> {
  const running = await db.select().from(matches).where(and(eq(matches.status, "running"), isNull(matches.pausedAt)));
  let acted = 0;
  for (const m of running) {
    enterMap(mapOf(m));
    const now = matchNow(m);
    const dueAi = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, m.id), eq(players.isAi, true), eq(players.hidden, false), isNull(players.eliminatedAt), or(isNull(players.nextAiAt), lte(players.nextAiAt, now))))
      .orderBy(players.nextAiAt)
      .limit(limit);
    for (const p of dueAi) {
      try {
        await runAiPlayer(db, m, p, now, publisher);
        acted += 1;
      } catch (err) {
        log.warn({ err, playerId: p.id }, "ai decision failed");
      }
    }
  }
  return acted;
}

/** Occupied regions drift toward a loyalty target; disloyal ones may rebel and go neutral. */
async function loyaltyAndRebellion(tx: Tx, m: MatchRow, now: Date, hours: number, rng: () => number, after: (fn: () => Promise<void>) => void, publisher: Publisher): Promise<void> {
  const c = balance.conquest;
  // Lock in ascending region order, the same order every other transaction uses, so the tick never deadlocks with a job or an AI command.
  const owned = await tx
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), isNotNull(matchRegions.ownerPlayerId)))
    .orderBy(asc(matchRegions.regionId))
    .for("update");
  const techFxByOwner = new Map<string, TechEffects>();
  const prow = await tx.select({ id: players.id, capital: players.capitalRegionId, boost: players.loyaltyBoostUntil }).from(players).where(eq(players.matchId, m.id));
  const capitals = new Map(prow.map((p) => [p.id, p.capital]));
  const boosted = new Set(prow.filter((p) => p.boost && p.boost > now).map((p) => p.id));
  for (const row of owned) {
    const owner = row.ownerPlayerId!;
    const capital = capitals.get(owner);
    if (!capital || capital === row.regionId) {
      if (row.loyalty < 1) await tx.update(matchRegions).set({ loyalty: 1 }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, row.regionId)));
      continue;
    }
    const effects = applyTechEffects(effectsOf(row.buildings), techFxByOwner.get(owner) ?? (techFxByOwner.set(owner, await ownerTechEffects(tx, owner)).get(owner)!));
    const km = distanceKm(capital, row.regionId);
    const pop = row.popWorkers + row.popSoldiers + row.popOccupiers;
    const occupierNeed = row.conquered ? (pop / 100) * c.occupiersPerHundred : 0;
    // Temples turn workers into occupiers over time, so a growing conquest keeps up without fresh settlers.
    const templeLevel = row.buildings.temple ?? 0;
    let occupiers = row.popOccupiers;
    if (row.conquered && templeLevel > 0 && occupiers < occupierNeed) {
      const convert = Math.min(occupierNeed - occupiers, c.templeConvertsPerHour * hours, Math.max(0, row.popWorkers - 1));
      if (convert > 0) {
        const settled = await settleAndLockRegion(tx, m.id, row.regionId, now, m.speed);
        const take = Math.min(convert, Math.max(0, settled.popWorkers - 1));
        if (take > 0) {
          occupiers = settled.popOccupiers + take;
          await tx.update(matchRegions).set({ popWorkers: settled.popWorkers - take, popOccupiers: occupiers }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, row.regionId)));
        }
      }
    }
    const occupierFactor = occupierNeed > 0 ? Math.min(1, occupiers / occupierNeed) : 1;
    const tale = boosted.has(owner) ? balance.events.expedition.taleLoyalty : 0;
    const target = Math.max(0, Math.min(1, 1 - km / c.distanceScaleKm + effects.loyalty + tale)) * (0.5 + 0.5 * occupierFactor);
    const loyalty = row.loyalty + (target - row.loyalty) * Math.min(1, c.loyaltyRate * hours);

    if (loyalty < c.rebelBelow && rng() < c.rebelChancePerTick) {
      // Rebellion: the region goes neutral, occupiers are killed, half the garrison deserts to the rebels.
      const settled = await settleAndLockRegion(tx, m.id, row.regionId, now, m.speed);
      const garrison = Object.values(settled.units).reduce((a, b) => a + b, 0);
      const rebels = Math.max(2, Math.floor(garrison * 0.5 + settled.popWorkers / 10));
      await tx
        .update(matchRegions)
        .set({ ownerPlayerId: null, popOccupiers: 0, popSoldiers: rebels, units: { warrior: rebels }, loyalty: 1 })
        .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, row.regionId)));
      const name = regionById(row.regionId)?.name ?? row.regionId;
      await notify(tx, m.id, owner, "battle", `${name} has rebelled and thrown out your occupiers`, { regionId: row.regionId });
      await handleRegionLost(tx, m, owner, row.regionId, now);
      const worth = Math.round((regionById(row.regionId)?.value ?? 5) * balance.events.bounty.rebelPerValue);
      await placeBounty(tx, m, { kind: "region", regionId: row.regionId, amount: { food: worth, wood: worth, stone: worth }, reason: `${name} rose in rebellion` }, now);
      after(() => publisher.toPlayer(m.id, owner, "region.conquered", { regionId: row.regionId }));
      continue;
    }
    if (Math.abs(loyalty - row.loyalty) > 1e-6) {
      await tx.update(matchRegions).set({ loyalty }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, row.regionId)));
    }
  }
}

/** Neutral tribes slowly raise warriors so they stay a nuisance. */
async function neutralGrowth(tx: Tx, m: MatchRow, now: Date, hours: number): Promise<void> {
  const add = (hours / 24) * balance.ai.neutralGrowthWarriorsPerDay;
  if (add <= 0) return;
  const rows = await tx
    .select({ regionId: matchRegions.regionId, popWorkers: matchRegions.popWorkers, popSoldiers: matchRegions.popSoldiers, units: matchRegions.units })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), isNull(matchRegions.ownerPlayerId), sql`${matchRegions.popWorkers} > 5`));
  for (const r of rows) {
    const n = Math.min(Math.floor(r.popWorkers * 0.3), Math.round(add + (r.units.warrior ?? 0) * 0.02 * hours));
    if (n <= 0) continue;
    const settled = await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed);
    const take = Math.min(n, Math.floor(settled.popWorkers));
    if (take <= 0) continue;
    await tx
      .update(matchRegions)
      .set({ popWorkers: settled.popWorkers - take, popSoldiers: settled.popSoldiers + take, units: { ...settled.units, warrior: (settled.units.warrior ?? 0) + take } })
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
  }
}
