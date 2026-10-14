/**
 * Player commands as plain functions. The HTTP routes and the AI both call
 * these, so humans and AI tribes play by exactly the same rules.
 * Every function validates, settles the regions it touches under a lock,
 * pays costs up front and returns what it created. Errors carry statusCode.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { armySpeed, balance, buildingBlockedBy, carryCapacity, buildingById, buildingCost, buildingSeconds, canAfford, effectsOf, findRoute, missingFor, realSeconds, regionById, techById, techCost, techSeconds, trainSeconds, travelSeconds, unitById, unitCost, type Cost, type MissionKind, caravanCarry, techEffectsOf, distanceKm } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, jobs, matchRegions, players } from "../db/schema.js";
import { matchDayAt, matchNow } from "./clock.js";
import { applyCost, settleAndLockRegion, stockOf, type MatchRegionRow, type Tx, roadSetFor } from "./regions.js";
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

export async function queueBuild(ctx: CommandContext, regionId: string, buildingId: string) {
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
    const cost = buildingCost(def, level, matchDayAt(m, now), regionById(regionId)?.neighbors.length ?? 1);
    const pooled: Record<string, number> = {};
    for (const r of payers) for (const [k, v] of Object.entries(stockOf(r))) pooled[k] = (pooled[k] ?? 0) + v;
    if (!canAfford(pooled, cost)) throw httpError(409, `not enough ${missingFor(pooled, cost).join(", ")} across your regions`);
    const remaining: Record<string, number> = { ...cost };
    for (const r of payers) {
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
    const startsAt = pending.length ? pending[pending.length - 1]!.endsAt : now;
    const endsAt = new Date(startsAt.getTime() + realSeconds(buildingSeconds(def, level), 0, m.speed) * 1000);
    const [j] = await tx
      .insert(jobs)
      .values({ matchId: m.id, playerId: p.id, regionId, kind: "build", refId: buildingId, level, slot: pending.length, payload: { cost }, startsAt, endsAt })
      .returning();
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
    const startsAt = pending.length ? pending[pending.length - 1]!.endsAt : now;
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
  if (body.mission !== "settle" && body.mission !== "conquer" && (units.settler ?? 0) > 0) throw httpError(400, "settlers only go on settle and conquer missions");
  const goods = Object.entries(body.cargo).reduce((a, [, v]) => a + v, 0);
  if (goods > 0) {
    const cap = carryCapacity(units, techs) + (HOSTILE.has(body.mission) ? 0 : body.people * balance.travel.carryPerPerson);
    if (goods > cap) throw httpError(400, `not enough carrying capacity: these units and people carry ${cap}, you are sending ${Math.round(goods)}. Caravans carry ${caravanCarry(techs)} each.`);
  }
  const roads = await roadSetFor(db, m.id, p.id, await alliesOf(db, m.id, p.id));
  const route = findRoute(regionId, body.targetRegionId, techs.has(balance.travel.seaTech), roads);
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
