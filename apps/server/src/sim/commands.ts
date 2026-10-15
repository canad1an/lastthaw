/**
 * Player commands as plain functions. The HTTP routes and the AI both call
 * these, so humans and AI tribes play by exactly the same rules.
 * Every function validates, settles the regions it touches under a lock,
 * pays costs up front and returns what it created. Errors carry statusCode.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { availableUnits, armySpeed, balance, buildingBlockedBy, carryCapacity, buildingById, buildingCost, buildingSeconds, canAfford, effectsOf, findRoute, missingFor, realSeconds, regionById, techById, techCost, techSeconds, trainSeconds, travelSeconds, unitById, unitCost, type Cost, type MissionKind, caravanCarry, techEffectsOf, distanceKm } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, jobs, matchRegions, players, tradeRoutes } from "../db/schema.js";
import { matchDayAt, matchNow } from "./clock.js";
import { applyCost, settleAndLockRegion, stockOf, type MatchRegionRow, type Tx, waySetsFor } from "./regions.js";
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
export async function pendingRegionJobs(tx: Tx | Db, matchId: string, regionId: string) {
  return tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.matchId, matchId), eq(jobs.regionId, regionId), inArray(jobs.kind, ["build", "train"]), isNull(jobs.completedAt), isNull(jobs.cancelledAt)))
    .orderBy(asc(jobs.startsAt), asc(jobs.id));
}

export async function queueBuild(ctx: CommandContext, regionId: string, buildingId: string, opts: { allowWait?: boolean } = {}) {
  const allowWait = opts.allowWait ?? true;
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
    for (const r of mine) locked.set(r.regionId, await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed));
    const row = locked.get(regionId)!;
    if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    if (row.frozenAt) throw httpError(409, "this region is frozen");
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
    // Pay what this region has now. Anything short is owed, and must arrive by caravan before the build starts.
    const here = stockOf(row);
    const paid: Record<string, number> = {};
    const owed: Record<string, number> = {};
    for (const [k, v] of Object.entries(cost)) {
      const local = Math.min(v, here[k] ?? 0);
      if (local > 0) paid[k] = local;
      if (v - local > 0.5) owed[k] = Math.ceil(v - local);
    }
    if (Object.keys(paid).length) await applyCost(tx, row, paid as Cost);
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
      return j!;
    }
    // Waiting job: parked until the materials are delivered (endsAt is only a placeholder; the job loop skips waiting jobs).
    const [j] = await tx
      .insert(jobs)
      .values({ matchId: m.id, playerId: p.id, regionId, kind: "build", refId: buildingId, level, slot: pending.length, payload: { cost, paid }, startsAt: now, endsAt: m.endsAt ?? new Date(now.getTime() + 365 * 86400_000), waitingFor: owed })
      .returning();
    // One stock-up route per source region: capital first, then nearest, each sending what it can spare.
    const still: Record<string, number> = { ...owed };
    for (const src of payers.slice(1)) {
      const have = stockOf(src);
      const part: Record<string, number> = {};
      for (const [k, v] of Object.entries(still)) {
        const t = Math.min(v, Math.floor(have[k] ?? 0));
        if (t >= 1) part[k] = t;
      }
      if (Object.keys(part).length === 0) continue;
      // Merge into an existing materials route from the same source, so one convoy carries everything queued.
      const [existing] = await tx
        .select()
        .from(tradeRoutes)
        .where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.fromRegionId, src.regionId), eq(tradeRoutes.toRegionId, regionId), sql`${tradeRoutes.forJobId} is not null`))
        .limit(1)
        .for("update");
      if (existing) {
        const target = { ...(existing.target ?? {}) };
        for (const [k, t] of Object.entries(part)) target[k] = (target[k] ?? 0) + t;
        await tx.update(tradeRoutes).set({ target, load: target, nextAt: new Date(Math.min(existing.nextAt.getTime(), now.getTime())) }).where(eq(tradeRoutes.id, existing.id));
      } else {
        await tx.insert(tradeRoutes).values({
          matchId: m.id,
          playerId: p.id,
          fromRegionId: src.regionId,
          toRegionId: regionId,
          mode: "fixed",
          load: part,
          share: 0,
          caravans: 3,
          everyHours: 1,
          target: part,
          delivered: {},
          nextAt: now,
          forJobId: j!.id,
        });
      }
      for (const [k, t] of Object.entries(part)) {
        still[k] = (still[k] ?? 0) - t;
        if (still[k]! <= 0) delete still[k];
      }
      if (Object.keys(still).length === 0) break;
    }
    return j!;
  });
}

export async function queueTrain(ctx: CommandContext, regionId: string, unitId: string, qty: number) {
  const { db, m, p, techs } = ctx;
  const def = unitById.get(unitId);
  if (!def || def.hidden) throw httpError(400, "unknown unit");
  if (def.age > p.age) throw httpError(400, `${def.name} needs a later age`);
  if (def.requires && !techs.has(def.requires)) throw httpError(400, `${def.name} needs ${techById.get(def.requires)?.name ?? def.requires}`);
  const region = regionById(regionId);
  if (def.needsResource && !region?.resources.includes(def.needsResource)) throw httpError(400, `${def.name} can only be trained where there are ${def.needsResource}`);
  if (def.minBatch && qty < def.minBatch) throw httpError(400, `${def.name}s are trained in groups of at least ${def.minBatch}`);
  if (def.hauler) {
    const better = availableUnits(p.age, techs).find((u) => u.hauler && u.carry > def.carry);
    if (better) throw httpError(400, `${def.name}s are no longer built; train ${better.name}s instead`);
  }

  return db.transaction(async (tx) => {
    const now = matchNow(m);
    const row = await settleAndLockRegion(tx, m.id, regionId, now, m.speed);
    if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    if (row.frozenAt) throw httpError(409, "this region is frozen");
    const pending = await pendingRegionJobs(tx, m.id, regionId);
    if (pending.length >= balance.queue.slotsPerRegion) throw httpError(409, "the build queue is full");
    const queuedPeople = pending.filter((j) => j.kind === "train").reduce((a, j) => a + (j.qty ?? 0), 0);
    if (row.popWorkers - queuedPeople < qty) throw httpError(409, "not enough free workers to train that many");
    const cost: Cost = unitCost(def, qty, matchDayAt(m, now));
    const stock = stockOf(row);
    if (!canAfford(stock, cost)) throw httpError(409, `not enough ${missingFor(stock, cost).join(", ")}`);
    await applyCost(tx, row, cost);
    const effects = effectsOf(row.buildings);
    const active = pending.filter((j) => !j.waitingFor);
    const startsAt = active.length ? active[active.length - 1]!.endsAt : now;
    const endsAt = new Date(startsAt.getTime() + realSeconds(trainSeconds(def, qty), effects.trainSpeed + techEffectsOf(techs).trainSpeed, m.speed) * 1000);
    const [j] = await tx
      .insert(jobs)
      .values({ matchId: m.id, playerId: p.id, regionId, kind: "train", refId: unitId, qty, slot: pending.length, payload: { cost }, startsAt, endsAt })
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
    if (def.earliestDay !== undefined && matchDayAt(m, now) < def.earliestDay) throw httpError(409, `${def.name} can be researched from day ${def.earliestDay + 1}`);
    // Research draws on every region you own: food, wood and stone from the capital first,
    // ore and horses from wherever they are, so nothing has to be hauled home.
    const mine = await tx
      .select({ regionId: matchRegions.regionId })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt)))
      .orderBy(asc(matchRegions.regionId));
    if (!mine.some((r) => r.regionId === p.capitalRegionId)) throw httpError(409, "you have lost your capital");
    const rows: MatchRegionRow[] = [];
    for (const r of mine) rows.push(await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed));
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
}

const HOSTILE: ReadonlySet<MissionKind> = new Set(["raid", "conquer"]);

export async function sendArmy(ctx: CommandContext, regionId: string, body: SendArmyInput) {
  const { db, m, p, techs } = ctx;
  if (!regionById(body.targetRegionId)) throw httpError(400, "unknown target");
  if (body.targetRegionId === regionId) throw httpError(400, "the army is already there");
  const units = Object.fromEntries(Object.entries(body.units).filter(([, n]) => n > 0));
  const unitCount = Object.values(units).reduce((a, b) => a + b, 0);
  // People may travel unescorted on friendly moves (evacuations); every other mission needs units.
  const unescorted = (body.mission === "move" || body.mission === "reinforce") && body.people > 0;
  if (unitCount === 0 && !unescorted) throw httpError(400, body.mission === "transport" ? "send at least one caravan to carry the goods" : "send at least one unit");
  if (body.mission === "conquer") {
    if ((units.settler ?? 0) < balance.conquest.occupiersRequired) throw httpError(400, `conquering needs at least ${balance.conquest.occupiersRequired} settlers ready to occupy the region; train them under the Train tab`);
    if (Object.keys(units).every((id) => id === "settler")) throw httpError(400, "settlers cannot fight: send soldiers with them");
    if (body.people > 0) throw httpError(400, "conquest takes settlers as occupiers, not people");
  }
  const civilians = Object.keys(units).filter((id) => unitById.get(id)?.civilian && !(body.mission === "conquer" && id === "settler"));
  if ((HOSTILE.has(body.mission) || body.mission === "scout") && civilians.length) throw httpError(400, "caravans cannot raid, conquer or scout; settlers only go along to occupy a conquest");
  if (body.mission === "relocate") throw httpError(400, "move the capital from the region panel");
  if (body.mission === "settle") {
    const settlers = units.settler ?? 0;
    if (settlers < balance.settle.settlersRequired) throw httpError(400, `settling needs at least ${balance.settle.settlersRequired} settlers`);
    if (Object.keys(units).some((id) => id !== "settler")) throw httpError(400, "only settlers can settle; send escorts separately");
  }
  if (!["settle", "conquer", "move", "reinforce"].includes(body.mission) && (units.settler ?? 0) > 0) throw httpError(400, "settlers only go on settle, conquer, move and reinforce missions");
  const goods = Object.entries(body.cargo).reduce((a, [, v]) => a + v, 0);
  if (goods > 0) {
    const cap = carryCapacity(units, techs) + (HOSTILE.has(body.mission) ? 0 : body.people * balance.travel.carryPerPerson);
    if (goods > cap) throw httpError(400, `not enough carrying capacity: these units and people carry ${cap}, you are sending ${Math.round(goods)}. Caravans carry ${caravanCarry(techs)} each.`);
  }
  const { roads, rails } = await waySetsFor(db, m.id, p.id, await alliesOf(db, m.id, p.id));
  const route = findRoute(regionId, body.targetRegionId, techs.has(balance.travel.seaTech), roads, rails);
  if (!route) throw httpError(400, techs.has(balance.travel.seaTech) ? "no route to that region" : "no land route; research Shipbuilding to cross the sea");
  const now = matchNow(m);

  return db.transaction(async (tx) => {
    const origin = await settleAndLockRegion(tx, m.id, regionId, now, m.speed);
    if (origin.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    // Roads are already in the route cost: legs between road regions are shorter.
    const walking = unitById.get("settler")?.speed ?? 4;
    const seconds = travelSeconds(route, (unitCount ? armySpeed(units) : walking) * (1 + techEffectsOf(techs).travel), m.speed);

    const [target] = await tx
      .select()
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, body.targetRegionId)))
      .limit(1);
    const targetOwner = target?.ownerPlayerId ?? null;
    const friendly = targetOwner === p.id || (targetOwner ? await areAllied(tx, m.id, p.id, targetOwner) : false);
    if ((body.mission === "reinforce" || body.mission === "move" || body.mission === "transport") && !friendly) {
      throw httpError(400, "that region is not yours or an ally's");
    }
    if (body.mission === "settle") {
      if (targetOwner) throw httpError(400, "that region is already claimed");
      if (target && (target.popWorkers + target.popSoldiers + target.popOccupiers >= 1 || Object.values(target.units).some((n) => n > 0))) {
        throw httpError(400, "a tribe already lives there; conquer it instead");
      }
    }
    if (HOSTILE.has(body.mission)) {
      if (friendly) throw httpError(400, "you cannot attack your own or allied regions");
      if (targetOwner) {
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
      if ((stock[k] ?? 0) < v) throw httpError(409, `not enough ${k} here`);
    }
    const newUnits = { ...origin.units };
    for (const [id, n] of Object.entries(units)) newUnits[id] = (newUnits[id] ?? 0) - n;
    await tx
      .update(matchRegions)
      .set({ units: newUnits, popSoldiers: origin.popSoldiers - unitCount, popWorkers: origin.popWorkers - body.people })
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, regionId)));
    if (Object.keys(body.cargo).length) await applyCost(tx, { ...origin, popSoldiers: origin.popSoldiers - unitCount }, body.cargo);

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
        path: route.path,
        status: "outbound",
        departsAt: now,
        arrivesAt,
      })
      .returning();
    await tx.insert(jobs).values({ matchId: m.id, playerId: p.id, regionId: body.targetRegionId, kind: "mission", refId: a!.id, startsAt: now, endsAt: arrivesAt });
    return { army: a!, targetOwner, route };
  });
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
  const waiting = pending.filter((j) => j.waitingFor && j.kind === "build");
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
      const def = buildingById.get(j.refId ?? "");
      if (!def) continue;
      const active = (await pendingRegionJobs(tx, m.id, regionId)).filter((x) => !x.waitingFor);
      const startsAt = new Date(Math.max(at.getTime(), active.length ? active[active.length - 1]!.endsAt.getTime() : 0));
      const endsAt = new Date(startsAt.getTime() + realSeconds(buildingSeconds(def, j.level ?? 1), 0, m.speed) * 1000);
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

/** Upgrade haulers in place: caravans to wagons, caravans or wagons to trains. Costs per unit, needs the unit's tech. */
export async function convertUnits(ctx: CommandContext, regionId: string, from: string, to: string, qty: number) {
  const { db, m, p, techs } = ctx;
  const src = unitById.get(from);
  const dst = unitById.get(to);
  if (!src?.hauler || !dst?.hauler) throw httpError(400, "only haulers can be upgraded");
  if (dst.carry <= src.carry) throw httpError(400, `${dst.name} is not an upgrade of ${src.name}`);
  if (dst.age > p.age) throw httpError(400, `${dst.name} needs a later age`);
  if (dst.requires && !techs.has(dst.requires)) throw httpError(400, `${dst.name} needs ${techById.get(dst.requires)?.name ?? dst.requires}`);
  const per = balance.trade.convertCost[to];
  if (!per) throw httpError(400, "that upgrade is not available");
  return db.transaction(async (tx) => {
    const now = matchNow(m);
    const row = await settleAndLockRegion(tx, m.id, regionId, now, m.speed);
    if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
    const have = row.units[from] ?? 0;
    const n = Math.min(qty, have);
    if (n < 1) throw httpError(409, `no ${src.name}s here to upgrade`);
    const cost: Record<string, number> = {};
    for (const [k, v] of Object.entries(per)) cost[k] = v * n;
    const stock = stockOf(row);
    if (!canAfford(stock, cost as Cost)) throw httpError(409, `not enough ${missingFor(stock, cost as Cost).join(", ")} here`);
    const paid = await applyCost(tx, row, cost as Cost);
    const units = { ...paid.units, [from]: have - n, [to]: (paid.units[to] ?? 0) + n };
    await tx.update(matchRegions).set({ units }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, regionId)));
    return { converted: n, cost };
  });
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
    .where(and(eq(jobs.matchId, m.id), eq(jobs.kind, "build"), isNull(jobs.completedAt), isNull(jobs.cancelledAt), sql`${jobs.waitingFor} is not null`))
    .orderBy(asc(jobs.regionId), asc(jobs.slot), asc(jobs.id));
  if (waiting.length === 0) return 0;
  let fixed = 0;
  const byRegion = new Map<string, typeof waiting>();
  for (const j of waiting) if (j.regionId) byRegion.set(j.regionId, [...(byRegion.get(j.regionId) ?? []), j]);
  for (const [regionId, list] of byRegion) {
    const first = list[0]!;
    if (!first.playerId) continue;
    const row = await settleAndLockRegion(tx, m.id, regionId, now, m.speed);
    if (row.ownerPlayerId !== first.playerId || row.frozenAt) continue;
    const owed = first.waitingFor as Record<string, number>;
    const stock = stockOf(row);
    if (Object.keys(owed).length === 0 || canAfford(stock, owed as Cost)) {
      if (Object.keys(owed).length) await applyCost(tx, row, owed as Cost);
      const r = await receiveMaterials(tx, m, regionId, owed, now);
      fixed += r.started;
      continue;
    }
    const [route] = await tx
      .select({ id: tradeRoutes.id })
      .from(tradeRoutes)
      .where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.toRegionId, regionId), sql`${tradeRoutes.forJobId} is not null`))
      .limit(1);
    if (route) continue;
    // No route is bringing it: source the shortfall from the capital, then the nearest region with stock.
    const [p] = await tx.select().from(players).where(eq(players.id, first.playerId)).limit(1);
    if (!p) continue;
    const mine = await tx
      .select()
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt)));
    const sources = mine
      .filter((r) => r.regionId !== regionId)
      .sort((a, b) => (a.regionId === p.capitalRegionId ? -1 : b.regionId === p.capitalRegionId ? 1 : distanceKm(regionId, a.regionId) - distanceKm(regionId, b.regionId)));
    const still: Record<string, number> = {};
    for (const [k, v] of Object.entries(owed)) still[k] = v - (stock[k] ?? 0) > 0 ? Math.ceil(v - (stock[k] ?? 0)) : 0;
    for (const k of Object.keys(still)) if (still[k]! <= 0) delete still[k];
    for (const src of sources) {
      const have = stockOf(src);
      const part: Record<string, number> = {};
      for (const [k, v] of Object.entries(still)) {
        const t = Math.min(v, Math.floor(have[k] ?? 0));
        if (t >= 1) part[k] = t;
      }
      if (Object.keys(part).length === 0) continue;
      await tx.insert(tradeRoutes).values({ matchId: m.id, playerId: p.id, fromRegionId: src.regionId, toRegionId: regionId, mode: "fixed", load: part, share: 0, caravans: 3, everyHours: 1, target: part, delivered: {}, nextAt: now, forJobId: first.id });
      for (const [k, t] of Object.entries(part)) {
        still[k] = (still[k] ?? 0) - t;
        if (still[k]! <= 0) delete still[k];
      }
      if (Object.keys(still).length === 0) break;
    }
  }
  return fixed;
}
