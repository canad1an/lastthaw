/**
 * Player commands as plain functions. The HTTP routes and the AI both call
 * these, so humans and AI tribes play by exactly the same rules.
 * Every function validates, settles the regions it touches under a lock,
 * pays costs up front and returns what it created. Errors carry statusCode.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { availableUnits, armySpeed, balance, buildingBlockedBy, carryCapacity, buildingById, buildingCost, buildingSeconds, canAfford, effectsOf, findRoute, missingFor, realSeconds, regionById, techById, techCost, techSeconds, trainSeconds, travelSeconds, unitById, unitCost, type Cost, type MissionKind, caravanCarry, techEffectsOf, distanceKm, haulerCarry, HAULER_IDS, splitNaval, seaLegsOf, laneKey, laneName, resolveCombat, laneLimitKm, isAirGroup, airRangeKm, airRoute } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, battles, jobs, matchRegions, matches, messages, players, tradeRoutes, regionSightings, playerTechs } from "../db/schema.js";
import { matchDayAt, matchNow } from "./clock.js";
import { wonderStarted } from "./endgame.js";
import { legSeconds } from "./legs.js";
import { peaceBetween } from "./diplomacy.js";
import { applyCost, settleAndLockRegion, stockOf, type MatchRegionRow, type Tx, waySetsFor, resourceMultOf, ownerTechEffects } from "./regions.js";
import { recordSpend } from "./ledger.js";
import { alliesOf, areAllied } from "./alliances.js";
import type { MatchRow } from "../worker/jobs.js";

export type PlayerRow = typeof players.$inferSelect;

export interface CommandContext {
  db: Db;
  m: MatchRow;
  p: PlayerRow;
  techs: ReadonlySet<string>;
}

export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** Pending (not completed, not cancelled) jobs for a region, in queue order. */
/**
 * Re-read the match inside the transaction. A command carries a match row read before the
 * transaction began (the AI process keeps one for a whole pass), so a match that finished or
 * paused in the meantime would otherwise take jobs that outlive it and sit open for ever.
 */
export async function requireRunning(tx: Tx, matchId: string): Promise<void> {
  const [row] = await tx.select({ status: matches.status, pausedAt: matches.pausedAt }).from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!row || row.status !== "running") throw httpError(409, "the match is not running");
  if (row.pausedAt) throw httpError(409, "the match is paused");
}

export async function pendingRegionJobs(tx: Tx | Db, matchId: string, regionId: string) {
  return tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.matchId, matchId), eq(jobs.regionId, regionId), inArray(jobs.kind, ["build", "train"]), isNull(jobs.completedAt), isNull(jobs.cancelledAt)))
    .orderBy(asc(jobs.startsAt), asc(jobs.id));
}

export async function queueBuild(ctx: CommandContext, regionId: string, buildingId: string, opts: { allowWait?: boolean; maxOwed?: number } = {}) {
  const allowWait = opts.allowWait ?? true;
  const maxOwed = opts.maxOwed ?? Infinity;
  const { db, m, p, techs } = ctx;
  const def = buildingById.get(buildingId);
  if (!def) throw httpError(400, "unknown building");
  if (def.age > p.age) throw httpError(400, `${def.name} needs the ${["Stone", "Bronze", "Iron", "Classical", "Medieval"][def.age]} Age`);
  if (def.requires && !techs.has(def.requires)) throw httpError(400, `${def.name} needs ${techById.get(def.requires)?.name ?? def.requires}`);
  const region = regionById(regionId);
  if (!region) throw httpError(400, "unknown region");
  const blocked = buildingBlockedBy(def, region);
  if (blocked) throw httpError(400, blocked);

  return db.transaction(async (tx) => {
    await requireRunning(tx, m.id);
    const now = matchNow(m);
    // Buildings are paid from the region first, then the capital, then any other region
    // (nearest first), so a level that costs more than one region can hold stays buildable.
    // Every region of mine is locked in ascending order, the lock order used everywhere.
    const mine = await tx
      .select({ regionId: matchRegions.regionId })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt)))
      .orderBy(asc(matchRegions.regionId));
    if (!mine.some((r) => r.regionId === regionId)) throw httpError(403, "not your region");
    const locked = new Map<string, MatchRegionRow>();
    for (const r of mine) locked.set(r.regionId, await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed, resourceMultOf(m)));
    const row = locked.get(regionId)!;
    if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    if (row.frozenAt) throw httpError(409, "this region is frozen");
    if (def.capitalOnly && !row.isCapital) throw httpError(400, `${def.name} can only be raised in your capital`);
    const payers: MatchRegionRow[] = [row];
    if (p.capitalRegionId && p.capitalRegionId !== regionId && locked.has(p.capitalRegionId)) payers.push(locked.get(p.capitalRegionId)!);
    for (const r of [...locked.values()].filter((x) => x.regionId !== regionId && x.regionId !== p.capitalRegionId).sort((a, b) => distanceKm(regionId, a.regionId) - distanceKm(regionId, b.regionId))) payers.push(r);
    const pending = await pendingRegionJobs(tx, m.id, regionId);
    if (pending.length >= balance.queue.slotsPerRegion) throw httpError(409, "the build queue is full");
    const queuedLevels = pending.filter((j) => j.kind === "build" && j.refId === buildingId).length;
    const level = (row.buildings[buildingId] ?? 0) + queuedLevels + 1;
    if (level > def.maxLevel) throw httpError(400, `${def.name} is at its maximum level`);
    if (def.requiresBuilding && (row.buildings[def.requiresBuilding] ?? 0) < 1) throw httpError(400, `${def.name} needs ${buildingById.get(def.requiresBuilding)?.name ?? def.requiresBuilding} here first`);
    const cost = buildingCost(def, level, matchDayAt(m, now), regionById(regionId)?.neighbors.length ?? 1);
    const pooled: Record<string, number> = {};
    for (const r of payers) for (const [k, v] of Object.entries(stockOf(r))) pooled[k] = (pooled[k] ?? 0) + v;
    if (!canAfford(pooled, cost)) throw httpError(409, `not enough ${missingFor(pooled, cost).join(", ")} across your regions`);
    if (!allowWait && !canAfford(stockOf(row), cost)) throw httpError(409, `not enough ${missingFor(stockOf(row), cost).join(", ")} here`);
    {
      const localStock = stockOf(row);
      const shortfall = Object.entries(cost).reduce((a, [k, v]) => a + Math.max(0, v - (localStock[k] ?? 0)), 0);
      if (shortfall > maxOwed) throw httpError(409, `too much would have to be shipped here (${Math.round(shortfall)}); build it where the stock is`);
    }
    // Pay what this region has now. Anything short is owed, and must arrive by caravan before the build starts.
    const here = stockOf(row);
    const paid: Record<string, number> = {};
    const owed: Record<string, number> = {};
    for (const [k, v] of Object.entries(cost)) {
      const local = Math.min(v, here[k] ?? 0);
      if (local > 0) paid[k] = local;
      if (v - local > 0.5) owed[k] = Math.ceil(v - local);
    }
    if (Object.keys(paid).length) await recordSpend(tx, m, p.id, "build", paid);
    const active = pending.filter((j) => !j.waitingFor);
    // A level queued behind a waiting job must not overtake it: it waits too, even if fully paid.
    const behindWaiting = pending.some((j) => j.waitingFor);
    if (Object.keys(owed).length === 0 && !behindWaiting) {
      const startsAt = active.length ? active[active.length - 1]!.endsAt : now;
      const endsAt = new Date(startsAt.getTime() + realSeconds(buildingSeconds(def, level), 0, m.speed) * 1000);
      const [j] = await tx
        .insert(jobs)
        .values({ matchId: m.id, playerId: p.id, regionId, kind: "build", refId: buildingId, level, slot: pending.length, payload: { cost, paid }, startsAt, endsAt })
        .returning();
      if (def.wonder) await wonderStarted(tx, m, p.id, p.name, regionId, endsAt, false);
      return j!;
    }
    // Waiting job: parked until the materials are delivered (endsAt is only a placeholder; the job loop skips waiting jobs).
    const [j] = await tx
      .insert(jobs)
      .values({ matchId: m.id, playerId: p.id, regionId, kind: "build", refId: buildingId, level, slot: pending.length, payload: { cost, paid }, startsAt: now, endsAt: m.endsAt ?? new Date(now.getTime() + 365 * 86400_000), waitingFor: owed })
      .returning();
    if (def.wonder) await wonderStarted(tx, m, p.id, p.name, regionId, j!.endsAt, true);
    await supplyWaitingJob(tx, m, p, techs, regionId, j!.id, owed, payers.slice(1), [...locked.values()], now);
    return j!;
  });
}

/**
 * A job waiting on materials gets them from the capital first, then the regions holding the most (small offers last):
 * the goods are set aside at each source into a materials route (one per source and destination), and any convoy
 * already collecting for the destination takes what it has room for. Builds and training both use it.
 */
export async function supplyWaitingJob(tx: Tx, m: MatchRow, p: PlayerRow, techs: ReadonlySet<string>, regionId: string, jobId: string, owed: Record<string, number>, sources: MatchRegionRow[], allMine: MatchRegionRow[], now: Date): Promise<void> {
  // Sources that can reach the destination: by land first; where there is no land way, a region joined to it by a
  // direct sea lane, served by ships. A region that is neither is no use to this order.
  const byLand = sources.filter((s) => !!findRoute(s.regionId, regionId, false));
  const bySea = sources.filter((s) => !byLand.includes(s) && (regionById(s.regionId)?.seaRoutes.includes(regionId) ?? false));
  const plan = planSources(owed, byLand, stockOf, p.capitalRegionId, haulerCarry("caravan", techs));
  const still: Record<string, number> = { ...owed };
  for (const { part } of plan) for (const [k, v] of Object.entries(part)) still[k] = Math.max(0, (still[k] ?? 0) - v);
  for (const k of Object.keys(still)) if (still[k]! < 1) delete still[k];
  if (Object.keys(still).length && bySea.length) plan.push(...planSources(still, bySea, stockOf, null, haulerCarry("cog", techs)));
  const [forJob] = await tx.select({ kind: jobs.kind }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  const category = forJob?.kind === "train" ? "military" : "build";
  for (const { src, part } of plan) {
    // Set aside at the source now, as a warehouse would for a delivery: nothing else can spend it, and the haulers load and leave on arrival.
    await applyCost(tx, src, part as Cost);
    await recordSpend(tx, m, p.id, category, part);
    // Merge into an existing materials route from the same source, so one convoy carries everything queued.
    const [existing] = await tx
      .select()
      .from(tradeRoutes)
      .where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.fromRegionId, src.regionId), eq(tradeRoutes.toRegionId, regionId), sql`${tradeRoutes.forJobId} is not null`))
      .limit(1)
      .for("update");
    let routeId: string;
    if (existing) {
      const target = { ...(existing.target ?? {}) };
      const held = { ...existing.held };
      for (const [k, t] of Object.entries(part)) {
        target[k] = (target[k] ?? 0) + t;
        held[k] = (held[k] ?? 0) + t;
      }
      const remaining: Record<string, number> = {};
      for (const [k, v] of Object.entries(target)) if (v - (existing.delivered[k] ?? 0) >= 1) remaining[k] = v - (existing.delivered[k] ?? 0);
      await tx.update(tradeRoutes).set({ target, load: target, held, caravans: supplyCaravans(remaining, allMine, techs), nextAt: new Date(Math.min(existing.nextAt.getTime(), now.getTime())) }).where(eq(tradeRoutes.id, existing.id));
      routeId = existing.id;
    } else {
      const [created] = await tx
        .insert(tradeRoutes)
        .values({ matchId: m.id, playerId: p.id, fromRegionId: src.regionId, toRegionId: regionId, mode: "fixed", load: part, share: 0, caravans: supplyCaravans(part, allMine, techs), everyHours: 1, target: part, delivered: {}, held: part, nextAt: now, forJobId: jobId })
        .returning({ id: tradeRoutes.id });
      routeId = created!.id;
    }
    // Convoys already collecting for this region take what they have room for, with an extra stop here.
    const placed = await placeOnConvoys(tx, m, p.id, routeId, src.regionId, regionId, part, techs);
    if (Object.keys(placed).length) {
      const [r] = await tx.select({ held: tradeRoutes.held }).from(tradeRoutes).where(eq(tradeRoutes.id, routeId));
      const held = { ...(r?.held ?? {}) };
      for (const [k, v] of Object.entries(placed)) held[k] = Math.max(0, (held[k] ?? 0) - v);
      await tx.update(tradeRoutes).set({ held }).where(eq(tradeRoutes.id, routeId));
    }
  }
}

/**
 * Pull a building down one level (a building built once is removed outright). Nothing is refunded. Refused while a level
 * of it is queued here, while another building here needs it to stand, and for wonders.
 */
export async function demolishBuilding(ctx: CommandContext, regionId: string, buildingId: string): Promise<{ level: number }> {
  const { db, m, p } = ctx;
  const def = buildingById.get(buildingId);
  if (!def) throw httpError(400, "unknown building");
  if (def.wonder) throw httpError(400, "a wonder is not pulled down");
  return db.transaction(async (tx) => {
    await requireRunning(tx, m.id);
    const now = matchNow(m);
    const row = await settleAndLockRegion(tx, m.id, regionId, now, m.speed, resourceMultOf(m));
    if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    if (row.frozenAt) throw httpError(409, "this region is frozen");
    const have = row.buildings[buildingId] ?? 0;
    if (have < 1) throw httpError(400, `there is no ${def.name} here`);
    const pending = await pendingRegionJobs(tx, m.id, regionId);
    if (pending.some((j) => j.kind === "build" && j.refId === buildingId)) throw httpError(409, `a level of ${def.name} is queued here; cancel it first`);
    const needsIt = Object.entries(row.buildings).find(([id, lvl]) => lvl >= 1 && buildingById.get(id)?.requiresBuilding === buildingId);
    if (needsIt && have <= 1) throw httpError(409, `${buildingById.get(needsIt[0])?.name ?? needsIt[0]} here needs ${def.name} to stand; pull that down first`);
    const buildings = { ...row.buildings };
    if (have <= 1) delete buildings[buildingId];
    else buildings[buildingId] = have - 1;
    await tx.update(matchRegions).set({ buildings }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, regionId)));
    return { level: buildings[buildingId] ?? 0 };
  });
}

export async function queueTrain(ctx: CommandContext, regionId: string, unitId: string, qty: number, opts: { allowWait?: boolean; maxOwed?: number } = {}) {
  const { db, m, p, techs } = ctx;
  const def = unitById.get(unitId);
  if (!def || def.hidden) throw httpError(400, "unknown unit");
  if (def.age > p.age) throw httpError(400, `${def.name} needs a later age`);
  if (def.requires && !techs.has(def.requires)) throw httpError(400, `${def.name} needs ${techById.get(def.requires)?.name ?? def.requires}`);
  const region = regionById(regionId);
  // A mount is paid for from the stores (every mounted unit costs a horse), so horses bred elsewhere or hauled in serve as
  // well as wild herds: the cost check below is the rule. Only a unit that needs the resource without paying for it must
  // stand where the resource is found.
  if (def.needsResource && !(def.cost[def.needsResource] ?? 0) && !region?.resources.includes(def.needsResource)) throw httpError(400, `${def.name} can only be trained where there are ${def.needsResource}`);
  if (def.naval && !region?.coastal) throw httpError(400, `${def.name}s are built on a coast`);
  if (def.minBatch && qty < def.minBatch) throw httpError(400, `${def.name}s are trained in groups of at least ${def.minBatch}`);
  // The fleet ladder (caravan, wagon, freight wagon, train, lorry) replaces its old rungs, since every one is rebuilt by the
  // next tech. Ships and aircraft are their own crafts: a canoe is still built beside a cog, and never outranked by a wagon.
  if (def.hauler && !def.naval && !def.air) {
    const better = availableUnits(p.age, techs).find((u) => u.hauler && !u.naval && !u.air && u.carry > def.carry);
    if (better) throw httpError(400, `${def.name}s are no longer built; train ${better.name}s instead`);
  }

  return db.transaction(async (tx) => {
    await requireRunning(tx, m.id);
    const now = matchNow(m);
    const row = await settleAndLockRegion(tx, m.id, regionId, now, m.speed, resourceMultOf(m));
    if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    if (row.frozenAt) throw httpError(409, "this region is frozen");
    const pending = await pendingRegionJobs(tx, m.id, regionId);
    if (pending.length >= balance.queue.slotsPerRegion) throw httpError(409, "the build queue is full");
    if (def.needsBuilding && (row.buildings[def.needsBuilding] ?? 0) < 1) throw httpError(400, `${def.name}s need a ${buildingById.get(def.needsBuilding)?.name ?? def.needsBuilding} here`);
    const queuedPeople = pending.filter((j) => j.kind === "train").reduce((a, j) => a + (j.qty ?? 0), 0);
    if (row.popWorkers - queuedPeople < qty) throw httpError(409, "not enough free workers to train that many");
    const cost: Cost = unitCost(def, qty, matchDayAt(m, now));
    const stock = stockOf(row);
    if (!canAfford(stock, cost)) {
      // Supplied by convoy, like a build: pay what is here, owe the rest, set it aside at the capital and the nearest stocked regions.
      // Players always may (as with builds); the advisors say when they would rather not.
      if (!(opts.allowWait ?? true)) throw httpError(409, `not enough ${missingFor(stock, cost).join(", ")}`);
      const mine = await tx
        .select({ regionId: matchRegions.regionId })
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt), sql`${matchRegions.regionId} <> ${regionId}`))
        .orderBy(asc(matchRegions.regionId));
      const others: MatchRegionRow[] = [];
      for (const r of mine) others.push(await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed, resourceMultOf(m)));
      const pooled: Record<string, number> = { ...stock };
      for (const r of others) for (const [k, v] of Object.entries(stockOf(r))) pooled[k] = (pooled[k] ?? 0) + v;
      if (!canAfford(pooled, cost)) throw httpError(409, `not enough ${missingFor(pooled, cost).join(", ")} across your regions`);
      const paid: Record<string, number> = {};
      const owed: Record<string, number> = {};
      let shortfall = 0;
      for (const [k, v] of Object.entries(cost)) {
        const local = Math.min(v, stock[k] ?? 0);
        if (local > 0) paid[k] = local;
        if (v - local > 0.5) {
          owed[k] = Math.ceil(v - local);
          shortfall += v - local;
        }
      }
      if (shortfall > (opts.maxOwed ?? Infinity)) throw httpError(409, `too much would have to be shipped here (${Math.round(shortfall)}); train where the stock is`);
      if (Object.keys(paid).length) await recordSpend(tx, m, p.id, "military", paid);
      const [j] = await tx
        .insert(jobs)
        .values({ matchId: m.id, playerId: p.id, regionId, kind: "train", refId: unitId, qty, slot: pending.length, payload: { cost, paid }, startsAt: now, endsAt: m.endsAt ?? new Date(now.getTime() + 365 * 86400_000), waitingFor: owed })
        .returning();
      const capital = others.find((r) => r.regionId === p.capitalRegionId);
      const sources = capital ? [capital, ...others.filter((r) => r !== capital)] : others;
      await supplyWaitingJob(tx, m, p, techs, regionId, j!.id, owed, sources, [row, ...others], now);
      return j!;
    }
    await applyCost(tx, row, cost);
    await recordSpend(tx, m, p.id, "military", cost);
    const effects = effectsOf(row.buildings);
    const active = pending.filter((j) => !j.waitingFor);
    const startsAt = active.length ? active[active.length - 1]!.endsAt : now;
    const endsAt = new Date(startsAt.getTime() + realSeconds(trainSeconds(def, qty), effects.trainSpeed + techEffectsOf(techs).trainSpeed, m.speed) * 1000);
    const [j] = await tx
      .insert(jobs)
      .values({ matchId: m.id, playerId: p.id, regionId, kind: "train", refId: unitId, qty, slot: pending.length, payload: { cost, paid: cost }, startsAt, endsAt })
      .returning();
    return j!;
  });
}

export async function queueResearch(ctx: CommandContext, techId: string) {
  const { db, m, p, techs } = ctx;
  const def = techById.get(techId);
  if (!def) throw httpError(400, "unknown tech");
  if (techs.has(techId)) throw httpError(409, "already researched");
  if (def.age > p.age) throw httpError(400, `${def.name} needs a later age`);
  if (!p.capitalRegionId) throw httpError(409, "no capital");

  return db.transaction(async (tx) => {
    await requireRunning(tx, m.id);
    const now = matchNow(m);
    // Research queues: the next tech starts when the current one finishes.
    const pending = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.playerId, p.id), eq(jobs.kind, "research"), isNull(jobs.completedAt), isNull(jobs.cancelledAt)))
      .orderBy(asc(jobs.endsAt));
    if (pending.length >= balance.queue.researchSlots) throw httpError(409, "the research queue is full");
    if (pending.some((j) => j.refId === techId)) throw httpError(409, "already queued");
    const known = new Set([...techs, ...pending.map((j) => j.refId!)]);
    for (const r of def.requires ?? []) if (!known.has(r)) throw httpError(400, `${def.name} needs ${techById.get(r)?.name ?? r}`);
    // NO_AGE_DAYS=1 lifts the earliest-day gates on the age techs (an experiment switch for local simulations, never set in production).
    if (def.earliestDay !== undefined && process.env.NO_AGE_DAYS !== "1" && matchDayAt(m, now) < def.earliestDay) throw httpError(409, `${def.name} can be researched from day ${def.earliestDay + 1}`);
    // Research draws on every region you own: food, wood and stone from the capital first,
    // ore and horses from wherever they are, so nothing has to be hauled home.
    const mine = await tx
      .select({ regionId: matchRegions.regionId })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt)))
      .orderBy(asc(matchRegions.regionId));
    if (!mine.some((r) => r.regionId === p.capitalRegionId)) throw httpError(409, "you have lost your capital");
    const rows: MatchRegionRow[] = [];
    for (const r of mine) rows.push(await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed, resourceMultOf(m)));
    const capital = rows.find((r) => r.regionId === p.capitalRegionId)!;
    const ordered = [capital, ...rows.filter((r) => r !== capital)];
    const pooled: Record<string, number> = {};
    for (const r of ordered) for (const [k, v] of Object.entries(stockOf(r))) pooled[k] = (pooled[k] ?? 0) + v;
    const cost = techCost(def, matchDayAt(m, now));
    if (!canAfford(pooled, cost)) throw httpError(409, `not enough ${missingFor(pooled, cost).join(", ")} across your regions`);
    const remaining: Record<string, number> = { ...cost };
    for (const r of ordered) {
      const have = stockOf(r);
      const take: Record<string, number> = {};
      for (const [k, v] of Object.entries(remaining)) {
        const t = Math.min(v, have[k] ?? 0);
        if (t > 0) take[k] = t;
      }
      if (Object.keys(take).length) {
        await applyCost(tx, r, take as Cost);
        await recordSpend(tx, m, p.id, "research", take);
        for (const [k, t] of Object.entries(take)) {
          remaining[k] = (remaining[k] ?? 0) - t;
          if (remaining[k]! <= 1e-9) delete remaining[k];
        }
      }
      if (Object.keys(remaining).length === 0) break;
    }
    const effects = effectsOf(capital.buildings);
    const startsAt = pending.length ? pending[pending.length - 1]!.endsAt : now;
    const endsAt = new Date(startsAt.getTime() + realSeconds(techSeconds(def), effects.researchSpeed + techEffectsOf(techs).researchSpeed, m.speed) * 1000);
    const [j] = await tx
      .insert(jobs)
      .values({ matchId: m.id, playerId: p.id, regionId: null, kind: "research", refId: techId, slot: pending.length, payload: { cost }, startsAt, endsAt })
      .returning();
    return j!;
  });
}

export interface SendArmyInput {
  mission: MissionKind;
  targetRegionId: string;
  units: Record<string, number>;
  people: number;
  cargo: Record<string, number>;
  /** The cargo was set aside earlier (a materials route's hold): it is not in the region's stores and is not taken from them. */
  prepaid?: boolean;
  /** A collecting convoy's itinerary (transport only): pickups, then the destination; the target is the first undone stop. */
  stops?: Array<{ regionId: string; routeId: string | null; take: Record<string, number>; done?: boolean }>;
}

const HOSTILE: ReadonlySet<MissionKind> = new Set(["raid", "conquer", "airstrike"]);

export async function sendArmy(ctx: CommandContext, regionId: string, body: SendArmyInput) {
  const { db, m, p, techs } = ctx;
  if (!regionById(body.targetRegionId)) throw httpError(400, "unknown target");
  if (body.targetRegionId === regionId) throw httpError(400, "the army is already there");
  const units = Object.fromEntries(Object.entries(body.units).filter(([, n]) => n > 0));
  let unitCount = Object.values(units).reduce((a, b) => a + b, 0);
  // People may travel unescorted on friendly moves (evacuations); every other mission needs units.
  const unescorted = (body.mission === "move" || body.mission === "reinforce") && body.people > 0;
  if (unitCount === 0 && !unescorted) throw httpError(400, body.mission === "transport" ? "send at least one caravan to carry the goods" : "send at least one unit");
  if (body.mission === "conquer") {
    if ((units.settler ?? 0) < balance.conquest.occupiersRequired) throw httpError(400, `conquering needs at least ${balance.conquest.occupiersRequired} settlers ready to occupy the region; train them under the Train tab`);
    if (Object.keys(units).every((id) => id === "settler")) throw httpError(400, "settlers cannot fight: send soldiers with them");
    if (body.people > 0) throw httpError(400, "conquest takes settlers as occupiers, not people");
  }
  // Aircraft fly alone, straight, and only to scout, carry goods or strike.
  const air = isAirGroup(units);
  if (!air && Object.keys(units).some((id) => unitById.get(id)?.air)) throw httpError(400, "aircraft fly alone: send ground units separately");
  if (air && !["scout", "transport", "airstrike"].includes(body.mission)) throw httpError(400, "aircraft scout, carry goods or strike; they cannot move, settle, conquer or patrol");
  if (body.mission === "airstrike" && !air) throw httpError(400, "only aircraft strike from the air");
  if (body.mission === "airstrike" && !Object.keys(units).some((id) => (unitById.get(id)?.attack ?? 0) >= 10)) throw httpError(400, "an airstrike needs bombers");
  if (air && body.people > 0) throw httpError(400, "aircraft carry goods, not people");
  const civilians = Object.keys(units).filter((id) => unitById.get(id)?.civilian && !(body.mission === "conquer" && id === "settler"));
  if ((HOSTILE.has(body.mission) || body.mission === "scout") && civilians.length) throw httpError(400, "caravans cannot raid, conquer or scout; settlers only go along to occupy a conquest");
  if (body.mission === "scout" && !air && Object.keys(units).some((id) => id !== balance.scoutUnit)) throw httpError(400, "only Scouts can scout an unknown region; train some first");
  if (body.mission === "relocate") throw httpError(400, "move the capital from the region panel");
  if (body.mission === "expedition") {
    const x = balance.events.expedition;
    const soldiers = Object.entries(units).reduce((a, [id, n]) => a + (unitById.get(id)?.civilian || unitById.get(id)?.naval ? 0 : n), 0);
    if (soldiers < x.minSoldiers) throw httpError(400, `an expedition needs at least ${x.minSoldiers} soldiers`);
    if (Object.keys(units).some((id) => unitById.get(id)?.civilian || unitById.get(id)?.naval)) throw httpError(400, "soldiers only on an expedition");
    if (body.people > 0 || Object.keys(body.cargo).length) throw httpError(400, "an expedition travels light: no people, no cargo");
    // Into the unknown: at least `minHops` away and never sighted.
    let ring = new Set([regionId]);
    const seen = new Set(ring);
    let hops = 0;
    let found = false;
    while (ring.size && hops < x.minHops) {
      const next = new Set<string>();
      for (const id of ring) for (const n of regionById(id)?.neighbors ?? []) if (!seen.has(n)) { seen.add(n); next.add(n); }
      hops += 1;
      if (next.has(body.targetRegionId)) found = true;
      ring = next;
    }
    if (found) throw httpError(400, `an expedition goes at least ${x.minHops} regions out; pick somewhere further`);
    const [sighting] = await db.select({ regionId: regionSightings.regionId }).from(regionSightings).where(and(eq(regionSightings.matchId, m.id), eq(regionSightings.playerId, p.id), eq(regionSightings.regionId, body.targetRegionId))).limit(1);
    if (sighting) throw httpError(400, "you have already seen that region; expeditions go into the unknown");
  }
  const { ships, rest: landUnits } = splitNaval(units);
  const hasShips = Object.keys(ships).length > 0;
  if (body.mission === "patrol") {
    if (!hasShips) throw httpError(400, "only ships patrol");
    if (Object.keys(landUnits).length) throw httpError(400, "a patrol is ships only; send the rest separately");
    if (body.people > 0 || Object.keys(body.cargo).length) throw httpError(400, "patrols carry nothing");
  }
  if (body.mission === "settle") {
    const settlers = units.settler ?? 0;
    if (settlers < balance.settle.settlersRequired) throw httpError(400, `settling needs at least ${balance.settle.settlersRequired} settlers`);
    // Boats may carry the settlers across; no soldiers come along.
    if (Object.keys(landUnits).some((id) => id !== "settler")) throw httpError(400, "only settlers can settle; send escorts separately");
  }
  if (!["settle", "conquer", "move", "reinforce"].includes(body.mission) && (units.settler ?? 0) > 0) throw httpError(400, "settlers only go on settle, conquer, move and reinforce missions");
  const goods = Object.entries(body.cargo).reduce((a, [, v]) => a + v, 0);
  if (goods > 0) {
    const cap = carryCapacity(units, techs) + (HOSTILE.has(body.mission) ? 0 : body.people * balance.travel.carryPerPerson);
    if (goods > cap) throw httpError(400, `not enough carrying capacity: these units and people carry ${cap}, you are sending ${Math.round(goods)}. Caravans carry ${caravanCarry(techs)} each.`);
  }
  const { roads, rails, harbors, stations } = await waySetsFor(db, m.id, p.id, await alliesOf(db, m.id, p.id));
  const origin0 = regionById(regionId);
  // Ships sail one lane: coast to coast, directly. Patrols sit on that lane.
  const directLane = !!origin0 && origin0.seaRoutes.includes(body.targetRegionId);
  if ((hasShips || body.mission === "patrol") && !directLane) throw httpError(400, "ships sail directly from one coast to another across a sea lane; pick a region joined to this one by sea");
  // Canoes keep to the short lanes.
  const laneLimit = laneLimitKm(units);
  if (hasShips && laneLimit !== null && distanceKm(regionId, body.targetRegionId) > laneLimit) throw httpError(400, `canoes keep to short lanes: that crossing is ${Math.round(distanceKm(regionId, body.targetRegionId))} km, over the ${laneLimit} km a canoe can manage. A Galley or Cog from a Harbor crosses open sea.`);
  const flightKm = air ? distanceKm(regionId, body.targetRegionId) : 0;
  if (air && flightKm > airRangeKm(units)) throw httpError(400, `out of range: that is ${Math.round(flightKm)} km and these aircraft fly ${airRangeKm(units)} km`);
  const route = air
    ? airRoute(regionId, body.targetRegionId)
    : hasShips || body.mission === "patrol"
    ? { path: [regionId, body.targetRegionId], cost: distanceKm(regionId, body.targetRegionId) * balance.travel.seaFactor * (harbors.has(regionId) && harbors.has(body.targetRegionId) ? balance.travel.harborBothFactor : harbors.has(regionId) || harbors.has(body.targetRegionId) ? balance.travel.harborOneFactor : 1), usesSea: true }
    : findRoute(regionId, body.targetRegionId, techs.has(balance.travel.seaTech), roads, rails, harbors);
  if (!route) throw httpError(400, techs.has(balance.travel.seaTech) ? "no route to that region" : "no land route; research Shipbuilding to cross the sea");
  const now = matchNow(m);
  const lanes = air ? [] : seaLegsOf(route.path);

  const outcome = await db.transaction(async (tx) => {
    await requireRunning(tx, m.id);
    const origin = await settleAndLockRegion(tx, m.id, regionId, now, m.speed, resourceMultOf(m));
    if (origin.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    if (air && !effectsOf(origin.buildings).airfield) throw httpError(400, "aircraft take off from an Airfield: build one here first");

    const [target] = await tx
      .select()
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, body.targetRegionId)))
      .limit(1);
    const targetOwner = target?.ownerPlayerId ?? null;
    const friendly = targetOwner === p.id || (targetOwner ? await areAllied(tx, m.id, p.id, targetOwner) : false);
    if (air && body.mission === "transport" && !effectsOf(target?.buildings ?? {}).airfield) throw httpError(400, "a transport plane lands only where there is an Airfield");
    if ((body.mission === "reinforce" || body.mission === "move" || body.mission === "transport") && !friendly) {
      throw httpError(400, "that region is not yours or an ally's");
    }
    if (body.mission === "settle") {
      if (targetOwner) throw httpError(400, "that region is already claimed");
      if (target && (target.popWorkers + target.popSoldiers + target.popOccupiers >= 1 || Object.values(target.units).some((n) => n > 0))) {
        throw httpError(400, "a tribe already lives there; conquer it instead");
      }
    }
    if (HOSTILE.has(body.mission) || body.mission === "expedition") {
      if (friendly && HOSTILE.has(body.mission)) throw httpError(400, "you cannot attack your own or allied regions");
      if (targetOwner && targetOwner !== p.id) {
        const peace = await peaceBetween(tx, m.id, p.id, targetOwner, now);
        if (peace) throw httpError(400, `you have ${peace.kind === "nap" ? "a pact" : "a ceasefire"} with them${peace.status === "ending" ? "; it ends soon" : ""}`);
      }
      if (targetOwner && HOSTILE.has(body.mission)) {
        const [owner] = await tx.select().from(players).where(eq(players.id, targetOwner)).limit(1);
        if (owner?.protectionUntil && owner.protectionUntil.getTime() > now.getTime()) throw httpError(400, `${owner.name} is under beginner protection`);
        if (p.protectionUntil && p.protectionUntil.getTime() > now.getTime()) {
          await tx.update(players).set({ protectionUntil: now }).where(eq(players.id, p.id));
        }
      }
    }

    for (const [id, n] of Object.entries(units)) if ((origin.units[id] ?? 0) < n) throw httpError(409, `not enough ${id} here`);
    if (origin.popWorkers < body.people) throw httpError(409, "not enough free people here");
    const stock = stockOf(origin);
    for (const [k, v] of Object.entries(body.cargo)) {
      if (!(k in stock)) throw httpError(400, `unknown cargo ${k}`);
      if (!body.prepaid && (stock[k] ?? 0) < v) throw httpError(409, `not enough ${k} here`);
    }

    // Enemy patrols on the lanes this trip crosses: the ships we verifiably own fight them first, or the crossing is turned back.
    // This runs under the origin lock, after the stock check, so nobody can fight with ships they do not have.
    let shipsAfter: Record<string, number> = { ...ships };
    if (lanes.length && body.mission !== "patrol") {
      const allies = await alliesOf(tx, m.id, p.id);
      const patrols = await tx
        .select()
        .from(armies)
        .where(and(eq(armies.matchId, m.id), eq(armies.mission, "patrol"), eq(armies.status, "outbound"), inArray(armies.lane, lanes), sql`${armies.playerId} <> ${p.id}`))
        .orderBy(armies.id)
        .for("update");
      for (const patrol of patrols) {
        if (allies.includes(patrol.playerId) || patrol.arrivesAt.getTime() <= now.getTime()) continue;
        const theirs = splitNaval(patrol.units).ships;
        if (Object.keys(theirs).length === 0) continue;
        if (Object.keys(shipsAfter).length === 0) throw httpError(409, `enemy ships patrol the ${laneName(patrol.lane!)} lane; send an escort of your own ships first`);
        const seed = `${m.seed}:lane:${patrol.id}:${now.getTime()}`;
        const result = resolveCombat({ units: shipsAfter, bonus: 0 }, { units: theirs, bonus: 0 }, seed);
        const remainingTheirs: Record<string, number> = { ...patrol.units };
        for (const [id, lost] of Object.entries(result.defenderLosses)) remainingTheirs[id] = Math.max(0, (remainingTheirs[id] ?? 0) - lost);
        const theirsLeft = Object.values(splitNaval(remainingTheirs).ships).reduce((a, b) => a + b, 0);
        await tx.update(armies).set({ units: remainingTheirs, ...(theirsLeft === 0 ? { status: "done" as const } : {}) }).where(eq(armies.id, patrol.id));
        await tx.insert(battles).values({ matchId: m.id, regionId, resolvedAt: now, seed, attackerPlayerId: p.id, defenderPlayerId: patrol.playerId, report: { mission: "sea", lane: patrol.lane, attacker: { before: shipsAfter, losses: result.attackerLosses }, defender: { before: theirs, losses: result.defenderLosses }, attackerWon: result.attackerWon } });
        const [other] = await tx.select({ name: players.name }).from(players).where(eq(players.id, patrol.playerId)).limit(1);
        await tx.insert(messages).values({ matchId: m.id, playerId: patrol.playerId, kind: "battle", subject: `${p.name} fought your patrol on the ${laneName(patrol.lane!)} lane: ${result.attackerWon ? "your ships were beaten" : "your ships held"}`, payload: { lane: patrol.lane, losses: result.defenderLosses } });
        await tx.insert(messages).values({ matchId: m.id, playerId: p.id, kind: "battle", subject: `Sea battle on the ${laneName(patrol.lane!)} lane against ${other?.name ?? "an enemy"}: ${result.attackerWon ? "lane cleared" : "escort beaten"}`, payload: { lane: patrol.lane, losses: result.attackerLosses } });
        shipsAfter = result.attackerRemaining;
        if (!result.attackerWon) {
          // The escort is sunk; the crossing is called off before it starts. Only the lost ships leave the region.
          const sunkUnits = { ...origin.units };
          let sunk = 0;
          for (const [id, n] of Object.entries(ships)) {
            const lost = n - (shipsAfter[id] ?? 0);
            sunkUnits[id] = Math.max(0, (sunkUnits[id] ?? 0) - lost);
            sunk += lost;
          }
          await tx.update(matchRegions).set({ units: sunkUnits, popSoldiers: Math.max(0, origin.popSoldiers - sunk) }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, regionId)));
          return { calledOff: `your escort was beaten on the ${laneName(patrol.lane!)} lane; the crossing is called off` } as const;
        }
      }
    }
    if (hasShips) {
      // Ships sunk clearing the lanes do not sail, but they do leave the region.
      for (const id of Object.keys(ships)) units[id] = shipsAfter[id] ?? 0;
      for (const id of Object.keys(units)) if (units[id]! <= 0) delete units[id];
    }
    const sailing = Object.values(units).reduce((a, b) => a + b, 0);
    const sunkNow = unitCount - sailing;
    // Roads are already in the route cost: legs between road regions are shorter.
    const walking = unitById.get("settler")?.speed ?? 4;
    const seconds = body.mission === "patrol" ? (balance.naval.patrolHours * 3600) / m.speed : await legSeconds(tx, m, { techs, roads, rails, harbors, stations }, route, sailing ? units : {}, now, walking);
    const newUnits = { ...origin.units };
    for (const [id, n] of Object.entries(units)) newUnits[id] = (newUnits[id] ?? 0) - n;
    // Ships sunk on the lane leave the region too.
    for (const [id, n] of Object.entries(ships)) newUnits[id] = Math.max(0, (newUnits[id] ?? 0) - (n - (shipsAfter[id] ?? 0)));
    await tx
      .update(matchRegions)
      .set({ units: newUnits, popSoldiers: Math.max(0, origin.popSoldiers - sailing - sunkNow), popWorkers: origin.popWorkers - body.people })
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, regionId)));
    if (Object.keys(body.cargo).length && !body.prepaid) await applyCost(tx, { ...origin, popSoldiers: origin.popSoldiers - sailing - sunkNow }, body.cargo);

    const arrivesAt = new Date(now.getTime() + seconds * 1000);
    const [a] = await tx
      .insert(armies)
      .values({
        matchId: m.id,
        playerId: p.id,
        mission: body.mission,
        originRegionId: regionId,
        targetRegionId: body.targetRegionId,
        units,
        cargo: { ...body.cargo, people: body.people },
        lane: body.mission === "patrol" ? laneKey(regionId, body.targetRegionId) : null,
        path: route.path,
        stops: body.stops ?? [],
        status: "outbound",
        departsAt: now,
        arrivesAt,
      })
      .returning();
    await tx.insert(jobs).values({ matchId: m.id, playerId: p.id, regionId: body.targetRegionId, kind: "mission", refId: a!.id, startsAt: now, endsAt: arrivesAt });
    // The defender hears of it at once: a message in their inbox (the bar shows it and chimes), with the arrival time.
    if (targetOwner && targetOwner !== p.id && HOSTILE.has(body.mission)) {
      const size = Object.values(units).reduce((s, n) => s + n, 0);
      const targetName = regionById(body.targetRegionId)?.name ?? body.targetRegionId;
      const hours = Math.max(1, Math.round((seconds / 3600) * m.speed));
      await tx.insert(messages).values({
        matchId: m.id,
        playerId: targetOwner,
        kind: "battle",
        subject: `${p.name} is marching on ${targetName}: about ${size} units, arriving in ${hours} game hour${hours === 1 ? "" : "s"}. Garrison it, wall it, or move the stock out.`,
        payload: { regionId: body.targetRegionId, arrivesAt: arrivesAt.toISOString(), incoming: true, from: p.id },
      });
    }
    return { army: a!, targetOwner, route };
  });
  // A beaten escort is committed (the ships are gone) and then reported as a refusal.
  if ("calledOff" in outcome) throw httpError(409, outcome.calledOff);
  return outcome;
}

/**
 * Materials arrived in a region: start any build jobs that were waiting for
 * them, in queue order, paying the owed part from the region's stock now.
 */
/**
 * Materials delivered to a region go straight into its waiting builds, in queue
 * order, before anything is put into storage: that money is already spent, so
 * the region's storage cap never blocks a build. Returns what was not needed
 * (to be stored normally) and how many builds started.
 */
export async function receiveMaterials(tx: Tx, m: MatchRow, regionId: string, cargo: Record<string, number>, at: Date): Promise<{ rest: Record<string, number>; started: number }> {
  const rest: Record<string, number> = { ...cargo };
  const pending = await pendingRegionJobs(tx, m.id, regionId);
  const waiting = pending.filter((j) => j.waitingFor && (j.kind === "build" || j.kind === "train"));
  let started = 0;
  for (const j of waiting) {
    const owed: Record<string, number> = { ...(j.waitingFor as Record<string, number>) };
    const payload = (j.payload ?? {}) as { cost?: Cost; paid?: Record<string, number> };
    const paid = { ...(payload.paid ?? {}) };
    let changed = Object.keys(owed).length === 0; // fully paid, only waiting its turn
    for (const [k, v] of Object.entries(owed)) {
      const take = Math.min(v, rest[k] ?? 0);
      if (take <= 0) continue;
      owed[k] = v - take;
      rest[k] = (rest[k] ?? 0) - take;
      paid[k] = (paid[k] ?? 0) + take;
      changed = true;
      if (owed[k]! <= 0.5) delete owed[k];
    }
    if (!changed) continue;
    if (Object.keys(owed).length === 0) {
      const active = (await pendingRegionJobs(tx, m.id, regionId)).filter((x) => !x.waitingFor);
      const startsAt = new Date(Math.max(at.getTime(), active.length ? active[active.length - 1]!.endsAt.getTime() : 0));
      let seconds: number;
      if (j.kind === "train") {
        const def = unitById.get(j.refId ?? "");
        if (!def) continue;
        const [row] = await tx.select({ buildings: matchRegions.buildings, ownerPlayerId: matchRegions.ownerPlayerId }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, regionId)));
        const fx = await ownerTechEffects(tx, row?.ownerPlayerId ?? null);
        seconds = realSeconds(trainSeconds(def, j.qty ?? 1), effectsOf(row?.buildings ?? {}).trainSpeed + fx.trainSpeed, m.speed);
      } else {
        const def = buildingById.get(j.refId ?? "");
        if (!def) continue;
        seconds = realSeconds(buildingSeconds(def, j.level ?? 1), 0, m.speed);
      }
      const endsAt = new Date(startsAt.getTime() + seconds * 1000);
      await tx.update(jobs).set({ waitingFor: null, startsAt, endsAt, payload: { ...payload, paid } }).where(eq(jobs.id, j.id));
      started += 1;
    } else {
      await tx.update(jobs).set({ waitingFor: owed, payload: { ...payload, paid } }).where(eq(jobs.id, j.id));
      break; // later jobs keep waiting behind this one
    }
  }
  for (const k of Object.keys(rest)) if ((rest[k] ?? 0) <= 0) delete rest[k];
  return { rest, started };
}

/**
 * Materials set aside for builds in `regionId` go back onto the shelves of the regions holding them, and the routes are removed.
 * Used when the waiting builds are cancelled. A source that is no longer the player's keeps nothing: the goods are lost with it.
 */
export async function returnHeld(tx: Tx, m: MatchRow, regionId: string, onlyRouteIds?: string[]): Promise<void> {
  const routes = await tx
    .select()
    .from(tradeRoutes)
    .where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.toRegionId, regionId), sql`${tradeRoutes.forJobId} is not null`))
    .for("update");
  for (const r of routes) {
    if (onlyRouteIds && !onlyRouteIds.includes(r.id)) continue;
    const held = Object.fromEntries(Object.entries(r.held).filter(([, v]) => v > 0));
    if (Object.keys(held).length) {
      const src = await settleAndLockRegion(tx, m.id, r.fromRegionId, matchNow(m), m.speed, resourceMultOf(m));
      if (src.ownerPlayerId === r.playerId) {
        await applyCost(tx, src, held as Cost, -1);
        await recordSpend(tx, m, r.playerId, "build", held, -1);
      }
    }
    await tx.delete(tradeRoutes).where(eq(tradeRoutes.id, r.id));
  }
}

/**
 * Goods just set aside for `toRegionId` at `fromRegionId`: a convoy still collecting for that destination, with room to
 * spare, gets an extra stop there and the goods ride with it, so a new build request reuses haulers already on the way.
 * Returns what was placed on convoys; the rest stays in the route's hold for the next convoy.
 */
export async function placeOnConvoys(tx: Tx, m: MatchRow, playerId: string, routeId: string, fromRegionId: string, toRegionId: string, goods: Record<string, number>, techs: ReadonlySet<string>): Promise<Record<string, number>> {
  const left: Record<string, number> = { ...goods };
  const placed: Record<string, number> = {};
  // The caller holds a region lock, and a convoy's arrival locks the army before its regions, so waiting here would deadlock:
  // a convoy that is busy right now is skipped and the goods wait in the hold for the next one.
  const convoys = await tx
    .select()
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, playerId), eq(armies.mission, "transport"), eq(armies.status, "outbound")))
    .for("update", { skipLocked: true });
  for (const a of convoys) {
    if (Object.values(left).every((v) => v < 1)) break;
    const stops = a.stops;
    const last = stops[stops.length - 1];
    if (!last || last.regionId !== toRegionId) continue;
    // Still collecting: some pickup ahead. On the final leg it is too late to add a stop.
    if (!stops.some((s) => !s.done && s.routeId)) continue;
    // Already called there: the goods wait for the next convoy rather than send this one back.
    if (stops.some((s) => s.regionId === fromRegionId && s.done)) continue;
    const aboard = Object.entries(a.cargo).reduce((x, [k, v]) => x + (k === "people" ? 0 : v), 0);
    const manifest = stops.filter((s) => !s.done).reduce((x, s) => x + Object.values(s.take).reduce((y, z) => y + z, 0), 0);
    let spare = carryCapacity(a.units, techs) - aboard - manifest;
    if (spare < 1) continue;
    // A new stop must be reachable by land from the convoy's last pickup; a stop it already plans needs no check.
    const pendingHere = stops.some((s) => !s.done && s.regionId === fromRegionId);
    const prev = stops.filter((s) => !s.done && s.routeId).pop()?.regionId ?? a.targetRegionId;
    if (!pendingHere && !findRoute(prev, fromRegionId, false)) continue;
    const take: Record<string, number> = {};
    for (const [k, v] of Object.entries(left)) {
      const t = Math.min(v, Math.floor(spare));
      if (t >= 1) {
        take[k] = t;
        spare -= t;
        left[k] = v - t;
        placed[k] = (placed[k] ?? 0) + t;
      }
    }
    if (Object.keys(take).length === 0) continue;
    const next = [...stops];
    const pending = next.find((s) => !s.done && s.regionId === fromRegionId);
    if (pending) {
      // About to call there anyway: load the extra on that stop.
      const merged = { ...pending.take };
      for (const [k, v] of Object.entries(take)) merged[k] = (merged[k] ?? 0) + v;
      pending.take = merged;
    } else {
      next.splice(next.length - 1, 0, { regionId: fromRegionId, routeId, take });
    }
    await tx.update(armies).set({ stops: next }).where(eq(armies.id, a.id));
  }
  return placed;
}

/**
 * Sources for what a build is short of: the capital first, then whoever holds the most of it. A region offering less
 * than a small share of one hauler load is left for a second pass, taken only if the bigger ones could not cover it.
 * Returns the parts to set aside, in order, until the bill is met or every region has been asked.
 */
export function planSources<R extends { regionId: string }>(short: Record<string, number>, regions: R[], stockFor: (r: R) => Record<string, number>, capitalRegionId: string | null, perHauler: number): Array<{ src: R; part: Record<string, number> }> {
  const still: Record<string, number> = { ...short };
  const out: Array<{ src: R; part: Record<string, number> }> = [];
  const useful = (r: R) => Object.entries(still).reduce((a, [k, v]) => a + Math.min(v, Math.floor(stockFor(r)[k] ?? 0)), 0);
  const ordered = [...regions].sort((a, b) => (a.regionId === capitalRegionId ? -1 : b.regionId === capitalRegionId ? 1 : useful(b) - useful(a)));
  const minimum = perHauler * balance.trade.minSupplyPickupShare;
  for (const pass of [minimum, 0]) {
    for (const src of ordered) {
      if (Object.keys(still).length === 0) return out;
      if (out.some((o) => o.src === src)) continue;
      const have = stockFor(src);
      const part: Record<string, number> = {};
      let total = 0;
      for (const [k, v] of Object.entries(still)) {
        const t = Math.min(v, Math.floor(have[k] ?? 0));
        if (t >= 1) {
          part[k] = t;
          total += t;
        }
      }
      if (total === 0 || (total < pass && src.regionId !== capitalRegionId)) continue;
      out.push({ src, part });
      for (const [k, t] of Object.entries(part)) {
        still[k] = (still[k] ?? 0) - t;
        if (still[k]! <= 0) delete still[k];
      }
    }
  }
  return out;
}

/** How many haulers a materials route should ask for: enough to carry its load in one trip with the best hauler the player owns, within the cap. */
function supplyCaravans(load: Record<string, number>, regionsOfMine: Array<{ units: Record<string, number> }>, techs: ReadonlySet<string>): number {
  const total = Object.values(load).reduce((a, b) => a + b, 0);
  let carry = haulerCarry("caravan", techs);
  for (const id of HAULER_IDS) {
    if (unitById.get(id)?.naval) continue;
    if (regionsOfMine.some((r) => (r.units[id] ?? 0) > 0)) carry = Math.max(carry, haulerCarry(id, techs));
  }
  return Math.max(1, Math.min(balance.trade.maxSupplyCaravans, Math.ceil(total / carry)));
}


/**
 * Self-healing for builds waiting on materials: if the region's own stock now
 * covers what is owed, pay and start; otherwise make sure a materials route
 * exists to bring it (routes that shipped and retired before the goods landed
 * would otherwise leave the build waiting for ever).
 */
export async function repairWaitingBuilds(tx: Tx, m: MatchRow, now: Date): Promise<number> {
  const waiting = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.matchId, m.id), inArray(jobs.kind, ["build", "train"]), isNull(jobs.completedAt), isNull(jobs.cancelledAt), sql`${jobs.waitingFor} is not null`))
    .orderBy(asc(jobs.regionId), asc(jobs.slot), asc(jobs.id));
  if (waiting.length === 0) return 0;
  let fixed = 0;
  const byRegion = new Map<string, typeof waiting>();
  for (const j of waiting) if (j.regionId) byRegion.set(j.regionId, [...(byRegion.get(j.regionId) ?? []), j]);
  for (const [regionId, list] of byRegion) {
    const first = list[0]!;
    if (!first.playerId) continue;
    const row = await settleAndLockRegion(tx, m.id, regionId, now, m.speed, resourceMultOf(m));
    if (row.ownerPlayerId !== first.playerId || row.frozenAt) continue;
    const owed = first.waitingFor as Record<string, number>;
    const stock = stockOf(row);
    // AI tribes never wait on big shipments: anything beyond a few hauler loads is cancelled and refunded.
    const [who] = await tx.select({ isAi: players.isAi }).from(players).where(eq(players.id, first.playerId)).limit(1);
    const owedTotal = Object.values(owed).reduce((a, b) => a + b, 0);
    if (who?.isAi && owedTotal > balance.ai.maxWaitingShipment) {
      for (const j of list) {
        const paid = ((j.payload ?? {}) as { paid?: Record<string, number> }).paid ?? {};
        if (Object.keys(paid).length) {
          await applyCost(tx, row, paid as Cost, -1);
          await recordSpend(tx, m, first.playerId, first.kind === "train" ? "military" : "build", paid, -1);
        }
        await tx.update(jobs).set({ cancelledAt: now }).where(eq(jobs.id, j.id));
      }
      await returnHeld(tx, m, regionId);
      continue;
    }
    if (Object.keys(owed).length === 0 || canAfford(stock, owed as Cost)) {
      if (Object.keys(owed).length) {
        await applyCost(tx, row, owed as Cost);
        await recordSpend(tx, m, first.playerId, first.kind === "train" ? "military" : "build", owed);
      }
      const r = await receiveMaterials(tx, m, regionId, owed, now);
      fixed += r.started;
      continue;
    }
    // What the materials routes heading here still promise, and what is already rolling in on the road.
    const routes = await tx
      .select()
      .from(tradeRoutes)
      .where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.toRegionId, regionId), sql`${tradeRoutes.forJobId} is not null`))
      .for("update");
    const promised: Record<string, number> = {};
    for (const r of routes) for (const [k, v] of Object.entries(r.held)) promised[k] = (promised[k] ?? 0) + Math.max(0, v);
    // Rolling: convoys bound here directly, and collecting convoys whose last stop is here, with what is aboard and what is still to be picked up.
    const rolling = await tx
      .select({ cargo: armies.cargo, targetRegionId: armies.targetRegionId, stops: armies.stops })
      .from(armies)
      .where(and(eq(armies.matchId, m.id), eq(armies.playerId, first.playerId), eq(armies.mission, "transport"), eq(armies.status, "outbound")));
    for (const a of rolling) {
      const dest = a.stops.length ? a.stops[a.stops.length - 1]!.regionId : a.targetRegionId;
      if (dest !== regionId) continue;
      for (const [k, v] of Object.entries(a.cargo)) if (k !== "people") promised[k] = (promised[k] ?? 0) + v;
      for (const s of a.stops) if (!s.done) for (const [k, v] of Object.entries(s.take)) promised[k] = (promised[k] ?? 0) + v;
    }
    // The whole queue's debt, not just the first job's: every waiting build here is served in order by the same routes.
    const allOwed: Record<string, number> = {};
    for (const j of list) for (const [k, v] of Object.entries((j.waitingFor ?? {}) as Record<string, number>)) allOwed[k] = (allOwed[k] ?? 0) + v;
    const still: Record<string, number> = {};
    for (const [k, v] of Object.entries(allOwed)) {
      const short = v - (stock[k] ?? 0) - (promised[k] ?? 0);
      if (short >= 1) still[k] = Math.ceil(short);
    }
    if (Object.keys(still).length === 0) continue;
    // Something is not on its way: source the shortfall from the capital, then the nearest region with stock, merging into a route from the same source.
    const [p] = await tx.select().from(players).where(eq(players.id, first.playerId)).limit(1);
    if (!p) continue;
    const techRows = await tx.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
    const techs = new Set(techRows.map((t) => t.id));
    const mine = await tx
      .select()
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt)));
    const sources = mine.filter((r) => r.regionId !== regionId);
    const plan = planSources(still, sources, stockOf, p.capitalRegionId, haulerCarry("caravan", techs));
    for (const { src, part } of plan) {
      const existing = routes.find((r) => r.fromRegionId === src.regionId);
      // Set aside at the source, under its lock, so nothing else spends it before the haulers come.
      const srcRow = await settleAndLockRegion(tx, m.id, src.regionId, now, m.speed, resourceMultOf(m));
      if (srcRow.ownerPlayerId !== p.id || !canAfford(stockOf(srcRow), part as Cost)) continue;
      await applyCost(tx, srcRow, part as Cost);
      await recordSpend(tx, m, p.id, first.kind === "train" ? "military" : "build", part);
      let routeId: string;
      if (existing) {
        const target = { ...(existing.target ?? {}) };
        const held = { ...existing.held };
        for (const [k, t] of Object.entries(part)) {
          target[k] = (target[k] ?? 0) + t;
          held[k] = (held[k] ?? 0) + t;
        }
        const remaining: Record<string, number> = {};
        for (const [k, v] of Object.entries(target)) if (v - (existing.delivered[k] ?? 0) >= 1) remaining[k] = v - (existing.delivered[k] ?? 0);
        await tx.update(tradeRoutes).set({ target, load: target, held, caravans: supplyCaravans(remaining, mine, techs), nextAt: new Date(Math.min(existing.nextAt.getTime(), now.getTime())) }).where(eq(tradeRoutes.id, existing.id));
        routeId = existing.id;
      } else {
        const [created] = await tx
          .insert(tradeRoutes)
          .values({ matchId: m.id, playerId: p.id, fromRegionId: src.regionId, toRegionId: regionId, mode: "fixed", load: part, share: 0, caravans: supplyCaravans(part, mine, techs), everyHours: 1, target: part, delivered: {}, held: part, nextAt: now, forJobId: first.id })
          .returning({ id: tradeRoutes.id });
        routeId = created!.id;
      }
      const placed = await placeOnConvoys(tx, m, p.id, routeId, src.regionId, regionId, part, techs);
      if (Object.keys(placed).length) {
        const [r] = await tx.select({ held: tradeRoutes.held }).from(tradeRoutes).where(eq(tradeRoutes.id, routeId));
        const held = { ...(r?.held ?? {}) };
        for (const [k, v] of Object.entries(placed)) held[k] = Math.max(0, (held[k] ?? 0) - v);
        await tx.update(tradeRoutes).set({ held }).where(eq(tradeRoutes.id, routeId));
      }
    }
  }
  return fixed;
}
