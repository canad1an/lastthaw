import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { claimBounties } from "./objectives.js";
import { tribeBattleTalk } from "./tribeVoice.js";
import { balance, effectsOf, emptySpecial, storageCaps, regionById, resolveCombat, carryCapacity, travelSeconds, findRoute, armySpeed, type UnitCounts, HAULER_IDS, haulerCount, unitById, laneName, applyTechEffects, wallBonusAgainst, breachOf, buildingById, seededRng, availableTechs, scoutCatchChance, soldierCount, wallOf, battleSchedule, type BattleRound, type CombatResult, isAirGroup, nextHopTo, haulerCarry, splitNaval, distanceKm } from "@lastthaw/shared";
import { matchDayAt, matchNow } from "./clock.js";
import { advisors, armies, battles, jobs, matchRegions, players, regionSightings, playerTechs, tradeRoutes, events } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { applyCost, settleAndLockRegion, type MatchRegionRow, type Tx, setCapital, ownerTechEffects, waySetsFor, stockOf, resourceMultOf } from "./regions.js";
import { notify, type JobRow, type MatchRow } from "../worker/jobs.js";
import { areAllied, alliesOf, landableFor, sailsFor } from "./alliances.js";
import { receiveMaterials } from "./commands.js";
import { legContextFor, legSeconds, routeFor, type LegContext } from "./legs.js";
import { clearMilitaryTargets } from "./advisorTargets.js";
import { causeForWar } from "./diplomacy.js";
import { enterMap, mapOf } from "../map/scope.js";
import type { Db } from "../db/client.js";
import { recordSpend } from "./ledger.js";

type ArmyRow = typeof armies.$inferSelect;
type After = (fn: () => Promise<void>) => void;

const BASE = ["food", "wood", "stone"] as const;
const SPECIAL = ["copper", "tin", "iron", "horses"] as const;

/** Make sure a row exists for a region (neutral and empty if nobody lives there), then lock and settle it. */
async function lockRegion(tx: Tx, m: MatchRow, regionId: string, at: Date): Promise<MatchRegionRow> {
  await tx
    .insert(matchRegions)
    .values({ matchId: m.id, regionId, assignment: { ...balance.start.assignment }, settledAt: at })
    .onConflictDoNothing();
  return settleAndLockRegion(tx, m.id, regionId, at, m.speed, resourceMultOf(m));
}

function sumUnits(u: UnitCounts): number {
  return Object.values(u).reduce((a, b) => a + b, 0);
}

function addUnits(a: UnitCounts, b: UnitCounts): UnitCounts {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (v > 0) out[k] = (out[k] ?? 0) + v;
  return out;
}

async function playerName(tx: Tx, id: string | null): Promise<string> {
  if (!id) return "Nobody";
  const [p] = await tx.select({ name: players.name }).from(players).where(eq(players.id, id)).limit(1);
  return p?.name ?? "Unknown";
}

/** Army arrival (outbound) or homecoming (returning). */
export async function resolveMission(tx: Tx, m: MatchRow, job: JobRow, publisher: Publisher, after: After): Promise<void> {
  if (!job.refId) throw new Error("mission job without army");
  const [army] = await tx.select().from(armies).where(eq(armies.id, job.refId)).for("update");
  if (!army || army.status === "done") return;
  if (army.status === "returning") return comeHome(tx, m, army, job.endsAt, publisher, after);

  const at = job.endsAt;
  switch (army.mission) {
    case "move":
    case "reinforce":
      return deliverUnits(tx, m, army, at, publisher, after);
    case "transport":
      return deliverCargo(tx, m, army, at, publisher, after);
    case "scout":
      return scout(tx, m, army, at, publisher, after);
    case "raid":
    case "conquer":
      return battle(tx, m, army, at, publisher, after);
    case "airstrike":
      return airstrike(tx, m, army, at, publisher, after);
    case "settle":
      return settleLand(tx, m, army, at, publisher, after);
    case "relocate":
      return relocateCapital(tx, m, army, at, publisher, after);
    case "patrol":
      await notify(tx, m.id, army.playerId, "system", `Patrol on the ${laneName(army.lane ?? "")} lane is over; the ships are sailing home`, { lane: army.lane });
      return sendHome(tx, m, army, at, army.units, army.cargo);
    case "expedition":
      return expedition(tx, m, army, at, publisher, after);
  }
}

/** An expedition arrives: a find, a hoard, a tale worth telling, or an ambush. Then home. */
async function expedition(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const x = balance.events.expedition;
  const rng = seededRng(`${m.seed}:expedition:${army.id}`);
  const roll = rng();
  const [p] = await tx.select().from(players).where(eq(players.id, army.playerId)).limit(1);
  const where = regionById(army.targetRegionId)?.name ?? army.targetRegionId;
  let units: UnitCounts = { ...army.units };
  const cargo: Record<string, number> = {};
  let outcome: string;
  if (roll < x.artifact) {
    // A free tech from the current age that is within reach.
    const known = new Set((await tx.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, army.playerId))).map((r) => r.id));
    const options = availableTechs(p?.age ?? 0, known).filter((t) => t.advancesTo === undefined);
    const pick = options[Math.floor(rng() * options.length)];
    if (pick) {
      await tx.insert(playerTechs).values({ matchId: m.id, playerId: army.playerId, techId: pick.id, completedAt: at }).onConflictDoNothing();
      outcome = `found an artifact: ${pick.name} is yours without research`;
      await tx.insert(events).values({ matchId: m.id, at, kind: "expedition.returned", payload: { playerId: army.playerId, regionId: army.targetRegionId, outcome: `found an artifact (${pick.name})` } });
    } else {
      cargo.iron = x.hoardIronPerAge;
      outcome = `found a cache of ${cargo.iron} iron`;
      await tx.insert(events).values({ matchId: m.id, at, kind: "expedition.returned", payload: { playerId: army.playerId, regionId: army.targetRegionId, outcome: "found a cache of iron" } });
    }
  } else if (roll < x.artifact + x.hoard) {
    cargo.iron = x.hoardIronPerAge * ((p?.age ?? 0) + 1);
    outcome = `found a hoard: ${cargo.iron} iron is coming home with them`;
    await tx.insert(events).values({ matchId: m.id, at, kind: "expedition.returned", payload: { playerId: army.playerId, regionId: army.targetRegionId, outcome: "found a hoard of iron" } });
  } else if (roll < x.artifact + x.hoard + x.tale) {
    const until = new Date(at.getTime() + (x.taleHours * 3600_000) / m.speed);
    await tx.update(players).set({ loyaltyBoostUntil: until }).where(eq(players.id, army.playerId));
    outcome = `came back with a tale that lifts loyalty across your lands for ${x.taleHours} hours`;
    await tx.insert(events).values({ matchId: m.id, at, kind: "expedition.returned", payload: { playerId: army.playerId, regionId: army.targetRegionId, outcome: "returned with an inspiring tale" } });
  } else {
    const lost: UnitCounts = {};
    for (const [id, n] of Object.entries(units)) {
      const l = Math.floor(n * x.ambushLoss);
      if (l > 0) lost[id] = l;
      units[id] = n - l;
    }
    units = Object.fromEntries(Object.entries(units).filter(([, n]) => n > 0));
    outcome = `was ambushed in ${where}: ${Object.values(lost).reduce((a, b) => a + b, 0)} did not come back`;
    await tx.insert(events).values({ matchId: m.id, at, kind: "expedition.returned", payload: { playerId: army.playerId, regionId: army.targetRegionId, outcome: "was ambushed" } });
  }
  await notify(tx, m.id, army.playerId, "scout", `Your expedition to ${where} ${outcome}.`, { regionId: army.targetRegionId, expedition: true });
  const pid = army.playerId;
  after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id }));
  return sendHome(tx, m, army, at, units, cargo);
}

/** The capital wagon arrives: stores are unloaded, the capital moves, and every idle caravan sets off for it. */
async function relocateCapital(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const name = regionById(army.targetRegionId)?.name ?? army.targetRegionId;
  if (target.ownerPlayerId !== army.playerId || target.frozenAt) {
    await notify(tx, m.id, army.playerId, "system", `${name} is no longer a place for your capital; the wagon is coming back`, { regionId: army.targetRegionId });
    return sendHome(tx, m, army, at, army.units, army.cargo, `${name} is no longer yours`);
  }
  await depositInto(tx, target, {}, army.cargo);
  await setCapital(tx, m.id, army.playerId, army.targetRegionId);
  await tx.update(armies).set({ status: "done" }).where(eq(armies.id, army.id));
  const sent = await gatherCaravans(tx, m, army.playerId, army.targetRegionId, at);
  await notify(tx, m.id, army.playerId, "system", `${name} is now your capital${sent ? `; ${sent} caravan${sent === 1 ? "" : "s"} are on their way there` : ""}`, { regionId: army.targetRegionId, caravans: sent });
  after(() => publisher.toPlayer(m.id, army.playerId, "region.updated", { regionId: army.targetRegionId }));
}

/**
 * Evacuated regions are swept each tick: whatever arrived or was left behind
 * leaves for the owner's capital, carrying what it can; a frozen region then
 * loses the rest for good, an unfrozen one keeps a stock-up route alive.
 */
/**
 * Migration: a region over its capacity sends a share of the surplus, every
 * tick, to neighbouring regions of the same owner that have room, split by
 * how much room each has. Workers only; soldiers and occupiers stay.
 */
export async function migrateCrowded(tx: Tx, m: MatchRow, now: Date, hours: number, playerIds: string[]): Promise<number> {
  const share = Math.min(1, balance.economy.migrationPerHour * hours);
  if (share <= 0 || playerIds.length === 0) return 0;
  const rows = await tx
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.ownerPlayerId, playerIds), isNull(matchRegions.frozenAt), isNull(matchRegions.evacuatedAt)))
    .orderBy(matchRegions.regionId);
  const byId = new Map(rows.map((r) => [r.regionId, r]));
  const techFx = new Map<string, Awaited<ReturnType<typeof ownerTechEffects>>>();
  const capacityOf = async (r: MatchRegionRow) => {
    const fx = techFx.get(r.ownerPlayerId!) ?? techFx.set(r.ownerPlayerId!, await ownerTechEffects(tx, r.ownerPlayerId)).get(r.ownerPlayerId!)!;
    return balance.economy.baseCapacity + applyTechEffects(effectsOf(r.buildings), fx).capacity;
  };
  const popOf = (r: MatchRegionRow) => r.popWorkers + r.popSoldiers + r.popOccupiers;
  let moved = 0;
  for (const r of rows) {
    const cap = await capacityOf(r);
    const excess = popOf(r) - cap;
    if (excess < 1) continue;
    const movers = Math.min(Math.floor(excess * share), Math.max(0, Math.floor(r.popWorkers) - 1));
    if (movers < 1) continue;
    // Neighbours of mine with room, weighted by room.
    const dests: Array<{ row: MatchRegionRow; room: number }> = [];
    for (const n of regionById(r.regionId)?.neighbors ?? []) {
      const d = byId.get(n);
      if (!d || d.ownerPlayerId !== r.ownerPlayerId) continue;
      // More workers in a conquered region short of occupiers only lowers its loyalty further.
      if (d.conquered && d.popOccupiers < (popOf(d) / 100) * balance.conquest.occupiersPerHundred) continue;
      const room = (await capacityOf(d)) - popOf(d);
      if (room >= 1) dests.push({ row: d, room });
    }
    if (dests.length === 0) continue;
    const totalRoom = dests.reduce((a, d) => a + d.room, 0);
    let left = movers;
    const src = await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed, resourceMultOf(m));
    for (const d of dests) {
      const take = Math.min(Math.floor(d.room), Math.max(0, Math.round((movers * d.room) / totalRoom)), left, Math.max(0, Math.floor(src.popWorkers) - 1));
      if (take < 1) continue;
      const dst = await settleAndLockRegion(tx, m.id, d.row.regionId, now, m.speed, resourceMultOf(m));
      await tx.update(matchRegions).set({ popWorkers: dst.popWorkers + take }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, d.row.regionId)));
      src.popWorkers -= take;
      d.row.popWorkers += take;
      left -= take;
      moved += take;
      if (left <= 0) break;
    }
    if (left < movers) await tx.update(matchRegions).set({ popWorkers: src.popWorkers }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
    r.popWorkers = src.popWorkers;
  }
  return moved;
}

export async function sweepEvacuated(tx: Tx, m: MatchRow, now: Date): Promise<void> {
  const rows = await tx
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), isNotNull(matchRegions.evacuatedAt), isNotNull(matchRegions.ownerPlayerId)))
    .orderBy(matchRegions.regionId);
  if (rows.length === 0) return;
  const owners = [...new Set(rows.map((r) => r.ownerPlayerId!))];
  const ps = await tx.select().from(players).where(inArray(players.id, owners));
  const byOwner = new Map(ps.map((p) => [p.id, p]));
  const ctxOf = new Map<string, LegContext>();
  for (const r of rows) {
    const p = byOwner.get(r.ownerPlayerId!);
    const capital = p?.capitalRegionId;
    if (!p || !capital || capital === r.regionId) continue;
    const row = await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed, resourceMultOf(m));
    const units: UnitCounts = {};
    for (const [id, n] of Object.entries(row.units)) if (n > 0) units[id] = n;
    const people = Math.floor(row.popWorkers + row.popOccupiers + 0.000001);
    const stock = stockOf(row);
    if (sumUnits(units) > 0 || people > 0) {
      let ctx = ctxOf.get(p.id);
      if (!ctx) ctxOf.set(p.id, (ctx = await legContextFor(tx, m.id, p.id)));
      const route = routeFor(ctx, r.regionId, capital);
      if (route) {
        const capacity = carryCapacity(units, ctx.techs) + people * balance.travel.carryPerPerson;
        const cargo: Record<string, number> = {};
        let left = capacity;
        for (const k of ["food", "wood", "stone", ...Object.keys(stock).filter((x) => !["food", "wood", "stone"].includes(x))]) {
          const take = Math.floor(Math.min(stock[k] ?? 0, left));
          if (take >= 1) {
            cargo[k] = take;
            left -= take;
          }
          if (left <= 0) break;
        }
        const seconds = await legSeconds(tx, m, ctx, route, units, now);
        const arrivesAt = new Date(now.getTime() + seconds * 1000);
        const [a] = await tx
          .insert(armies)
          .values({ matchId: m.id, playerId: p.id, mission: "move", originRegionId: r.regionId, targetRegionId: capital, units, cargo: { ...cargo, people }, path: route.path, status: "outbound", departsAt: now, arrivesAt })
          .returning();
        await tx.insert(jobs).values({ matchId: m.id, playerId: p.id, regionId: capital, kind: "mission", refId: a!.id, startsAt: now, endsAt: arrivesAt });
        const emptied = { ...row.units };
        for (const id of Object.keys(units)) emptied[id] = 0;
        const set: Partial<MatchRegionRow> = { units: emptied, popSoldiers: 0, popWorkers: 0, popOccupiers: 0 };
        for (const [k, v] of Object.entries(cargo)) {
          if (k === "food" || k === "wood" || k === "stone") set[k] = Math.max(0, row[k] - v);
        }
        const special = { ...emptySpecial(), ...(row.special as Record<string, number>) };
        for (const [k, v] of Object.entries(cargo)) if (k in special) special[k as keyof typeof special] = Math.max(0, (special[k as keyof typeof special] ?? 0) - v);
        set.special = special;
        await tx.update(matchRegions).set(set).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
      }
    }
    if (row.frozenAt) {
      // The ice has it: nothing left here is coming out.
      await tx
        .update(matchRegions)
        .set({ food: 0, wood: 0, stone: 0, special: emptySpecial(), popWorkers: 0, popOccupiers: 0 })
        .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
      await tx.delete(tradeRoutes).where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.fromRegionId, r.regionId)));
    } else {
      // Keep a stock-up route alive for whatever is still in store.
      const remaining = stockOf(await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed, resourceMultOf(m)));
      const target: Record<string, number> = {};
      for (const [k, v] of Object.entries(remaining)) if (v >= 1) target[k] = Math.floor(v);
      const [existing] = await tx
        .select({ id: tradeRoutes.id })
        .from(tradeRoutes)
        .where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.fromRegionId, r.regionId), eq(tradeRoutes.toRegionId, capital), sql`${tradeRoutes.target} is not null`))
        .limit(1);
      if (Object.keys(target).length && !existing) {
        await tx.insert(tradeRoutes).values({ matchId: m.id, playerId: p.id, fromRegionId: r.regionId, toRegionId: capital, mode: "fixed", load: target, share: 0, caravans: 5, everyHours: 1, target, delivered: {}, nextAt: now });
      }
    }
  }
}

/** Every stationed caravan outside `targetRegionId` walks there. Returns how many were sent. */
async function gatherCaravans(tx: Tx, m: MatchRow, playerId: string, targetRegionId: string, at: Date): Promise<number> {
  const [p] = await tx.select().from(players).where(eq(players.id, playerId)).limit(1);
  if (!p) return 0;
  const ctx = await legContextFor(tx, m.id, playerId);
  const rows = await tx
    .select({ regionId: matchRegions.regionId, units: matchRegions.units, frozenAt: matchRegions.frozenAt })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId)))
    .orderBy(matchRegions.regionId);
  let sent = 0;
  for (const r of rows) {
    if (r.regionId === targetRegionId || r.frozenAt || haulerCount(r.units) <= 0) continue;
    const route = routeFor(ctx, r.regionId, targetRegionId);
    if (!route) continue;
    const row = await settleAndLockRegion(tx, m.id, r.regionId, at, m.speed, resourceMultOf(m));
    const going: UnitCounts = {};
    for (const id of HAULER_IDS) if ((row.units[id] ?? 0) > 0 && !unitById.get(id)?.naval) going[id] = row.units[id]!;
    const have = sumUnits(going);
    if (have <= 0) continue;
    const seconds = await legSeconds(tx, m, ctx, route, going, at);
    const units = { ...row.units };
    for (const id of Object.keys(going)) units[id] = 0;
    await tx.update(matchRegions).set({ units, popSoldiers: Math.max(0, row.popSoldiers - have) }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
    const arrivesAt = new Date(at.getTime() + seconds * 1000);
    const [a] = await tx
      .insert(armies)
      .values({ matchId: m.id, playerId, mission: "move", originRegionId: r.regionId, targetRegionId, units: going, cargo: {}, path: route.path, status: "outbound", departsAt: at, arrivesAt })
      .returning();
    await tx.insert(jobs).values({ matchId: m.id, playerId, regionId: targetRegionId, kind: "mission", refId: a!.id, startsAt: at, endsAt: arrivesAt });
    sent += have;
  }
  return sent;
}

/** Settlers claim an empty region and become its first workers. */
async function settleLand(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const name = regionById(army.targetRegionId)?.name ?? army.targetRegionId;
  // Land that became ours before the settlers arrived: they stay, as occupiers if it was conquered, as settlers otherwise.
  if (target.ownerPlayerId === army.playerId) return deliverUnits(tx, m, army, at, publisher, after);
  const occupied = target.ownerPlayerId || target.popWorkers + target.popSoldiers + target.popOccupiers >= 1 || Object.values(target.units).some((n) => n > 0);
  if (occupied) {
    const by = target.ownerPlayerId ? await playerName(tx, target.ownerPlayerId) : "a neutral tribe";
    await notify(tx, m.id, army.playerId, "system", `${name} was claimed by ${by} before your settlers arrived; they are coming back`, { regionId: army.targetRegionId });
    return sendHome(tx, m, army, at, army.units, army.cargo, `${name} was claimed first by ${by}`);
  }
  const settlers = army.units.settler ?? 0;
  await clearMilitaryTargets(tx, m.id, army.playerId, [army.targetRegionId]);
  await tx
    .update(matchRegions)
    .set({
      ownerPlayerId: army.playerId,
      popWorkers: settlers + (army.cargo.people ?? 0),
      conquered: false,
      popSoldiers: 0,
      popOccupiers: 0,
      units: {},
      loyalty: balance.settle.startingLoyalty,
      assignment: { ...balance.start.assignment },
      food: Math.max(target.food, balance.settle.seedFood) + (army.cargo.food ?? 0),
      wood: target.wood + (army.cargo.wood ?? 0),
      stone: target.stone + (army.cargo.stone ?? 0),
    })
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, army.targetRegionId)));
  await tx.update(armies).set({ status: "done" }).where(eq(armies.id, army.id));
  await notify(tx, m.id, army.playerId, "system", `Your settlers have founded a new home in ${name}`, { regionId: army.targetRegionId, people: settlers });
  const pid = army.playerId;
  after(() => publisher.toPlayer(m.id, pid, "region.conquered", { regionId: army.targetRegionId }));
}

/** True when two consecutive regions of a path are not land neighbours: that leg was a sea crossing. */
function pathUsesSea(path: readonly string[]): boolean {
  return path.some((id, i) => i > 0 && !(regionById(path[i - 1]!)?.neighbors.includes(id) ?? true));
}

/**
 * An airstrike: the bombers hit the region's defenders once and fly home. Nothing changes hands, nothing is taken, and
 * walls do not count (bombs come over them); the region's Anti-air battery shoots a share of the planes down on the way out.
 */
async function airstrike(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const region = regionById(army.targetRegionId)!;
  const pid = army.playerId;
  const friendly = target.ownerPlayerId === army.playerId || (target.ownerPlayerId ? await areAllied(tx, m.id, army.playerId, target.ownerPlayerId) : false);
  if (friendly) {
    await notify(tx, m.id, army.playerId, "battle", `Airstrike on ${region.name} called off: the region is friendly`, { regionId: region.id });
    await sendHome(tx, m, army, at, army.units, {}, "called off: the region is friendly");
    after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id }));
    return;
  }
  const effects = effectsOf(target.buildings);
  const militia = Math.floor(((target.popWorkers + target.popOccupiers) / 10) * balance.combat.militiaPerTenPeople);
  const standing: UnitCounts = {};
  for (const [id, n] of Object.entries(target.units)) if (n > 0 && !unitById.get(id)?.hauler) standing[id] = n;
  const defenderUnits: UnitCounts = militia > 0 ? addUnits(standing, { militia }) : standing;
  const attackerTech = await ownerTechEffects(tx, army.playerId);
  const defenderTech = await ownerTechEffects(tx, target.ownerPlayerId);
  const terrain = balance.combat.terrainDefense[region.terrain] ?? 0;
  const bonus = effects.defense + defenderTech.defense + terrain;
  const result = resolveCombat({ units: army.units, bonus: attackerTech.attack }, { units: defenderUnits, bonus }, `${m.seed}:air:${army.id}:${at.getTime()}`);
  // Defender losses land: units fall, militia losses cost people.
  const { militia: militiaLost = 0, ...unitLosses } = result.defenderLosses;
  const newUnits = { ...target.units };
  let soldierLoss = 0;
  for (const [k, v] of Object.entries(unitLosses)) {
    newUnits[k] = Math.max(0, (newUnits[k] ?? 0) - v);
    soldierLoss += v;
  }
  await tx
    .update(matchRegions)
    .set({ units: newUnits, popSoldiers: Math.max(0, target.popSoldiers - soldierLoss), popWorkers: Math.max(0, target.popWorkers - militiaLost * 10 * 0.5) })
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, target.regionId)));
  // Then the battery: a share of the surviving planes is shot down on the way out.
  const survivors: UnitCounts = { ...result.attackerRemaining };
  const shotShare = Math.min(balance.combat.antiAirMax, effects.antiAir);
  let shot = 0;
  for (const [id, n] of Object.entries(survivors)) {
    const down = Math.round(n * shotShare);
    if (down > 0) {
      survivors[id] = n - down;
      shot += down;
    }
  }
  const attackerLosses: UnitCounts = { ...result.attackerLosses };
  if (shot > 0) for (const [id, n] of Object.entries(result.attackerRemaining)) attackerLosses[id] = (attackerLosses[id] ?? 0) + (n - (survivors[id] ?? 0));
  const attackerName = await playerName(tx, army.playerId);
  const defenderName = target.ownerPlayerId ? await playerName(tx, target.ownerPlayerId) : "Neutral tribes";
  const report = { regionName: region.name, regionId: region.id, mission: "airstrike", attackerName, defenderName, attackerWon: result.attackerWon, rounds: result.rounds, attacker: { before: army.units, losses: attackerLosses }, defender: { before: defenderUnits, losses: result.defenderLosses }, loot: {}, conquered: false, shotDown: shot };
  const fell = Object.values(result.defenderLosses).reduce((a, b) => a + b, 0);
  await notify(tx, m.id, army.playerId, "battle", `Airstrike on ${region.name}: ${fell} defender${fell === 1 ? "" : "s"} fell${shot ? `, ${shot} plane${shot === 1 ? "" : "s"} shot down` : ""}`, { regionId: region.id, report });
  if (target.ownerPlayerId) await notify(tx, m.id, target.ownerPlayerId, "battle", `${attackerName} bombed ${region.name}: ${fell} defender${fell === 1 ? "" : "s"} lost${shot ? `, ${shot} of their planes shot down` : ""}`, { regionId: region.id, report });
  await tx.insert(events).values({ matchId: m.id, at, kind: "airstrike", payload: { playerId: army.playerId, regionId: region.id, ownerPlayerId: target.ownerPlayerId, fell, shot } });
  await sendHome(tx, m, army, at, survivors, {});
  after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id }));
}

/** Send the army back where it came from, carrying whatever is in cargo. */
async function sendHome(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, units: UnitCounts, cargo: Record<string, number>, note: string | null = null): Promise<void> {
  if (sumUnits(units) === 0 && Object.values(cargo).every((v) => !v)) {
    await tx.update(armies).set({ status: "done", units, cargo }).where(eq(armies.id, army.id));
    return;
  }
  const ctx = await legContextFor(tx, m.id, army.playerId);
  // Came over the sea and no ship left to carry them: nobody swims, so they walk home over land.
  if (pathUsesSea(army.path) && Object.keys(splitNaval(units).ships).length === 0 && !isAirGroup(units)) {
    const walk = await strandedWalk(tx, m, army, units, ctx);
    if (!walk) return;
    units = walk.units;
    army = { ...army, originRegionId: walk.home };
    note = walk.note;
    if (sumUnits(units) === 0) {
      await tx.update(armies).set({ status: "done", units, cargo: {} }).where(eq(armies.id, army.id));
      return;
    }
    const seconds = await legSeconds(tx, m, ctx, walk.route, units, at, 5);
    const returnsAt = new Date(at.getTime() + seconds * 1000);
    await tx.update(armies).set({ status: "returning", units, cargo, returnsAt, note, originRegionId: walk.home, path: [...walk.route.path].reverse() }).where(eq(armies.id, army.id));
    await tx.insert(jobs).values({ matchId: m.id, playerId: army.playerId, regionId: walk.home, kind: "mission", refId: army.id, startsAt: at, endsAt: returnsAt });
    return;
  }
  // The way home may use the sea only if the way out did (or the player can sail): a land convoy does not swim back.
  const route = routeFor(ctx, army.targetRegionId, army.originRegionId, pathUsesSea(army.path), units) ?? { path: [army.targetRegionId, army.originRegionId], cost: 1000, usesSea: false };
  const seconds = await legSeconds(tx, m, ctx, route, units, at, 5);
  const returnsAt = new Date(at.getTime() + seconds * 1000);
  await tx.update(armies).set({ status: "returning", units, cargo, returnsAt, note }).where(eq(armies.id, army.id));
  await tx.insert(jobs).values({ matchId: m.id, playerId: army.playerId, regionId: army.originRegionId, kind: "mission", refId: army.id, startsAt: at, endsAt: returnsAt });
}

/**
 * A force stranded across the sea walks home over land: to where it set out if a land route goes there, else to the
 * nearest region of the player's that one does. Every region on the way not held by the player or an ally may catch
 * it (balance.travel.strandedCatchPerRegion), costing it a share of every unit. With no land route to any region of
 * the player's, it is lost. Returns null when lost; the army row is closed and the player told.
 */
async function strandedWalk(tx: Tx, m: MatchRow, army: ArmyRow, units: UnitCounts, ctx: LegContext): Promise<{ route: { path: string[]; cost: number; usesSea: boolean }; home: string; units: UnitCounts; note: string } | null> {
  const t = balance.travel;
  const where = regionById(army.targetRegionId)?.name ?? army.targetRegionId;
  const count = (u: UnitCounts) => sumUnits(u);
  const friendlyOwners = new Set([army.playerId, ...(await alliesOf(tx, m.id, army.playerId))]);
  const mine = await tx.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, army.playerId), isNull(matchRegions.frozenAt)));
  const candidates = [army.originRegionId, ...mine.map((r) => r.regionId).filter((id) => id !== army.originRegionId).sort((a, b) => distanceKm(army.targetRegionId, a) - distanceKm(army.targetRegionId, b))];
  let home: string | null = null;
  let route: { path: string[]; cost: number; usesSea: boolean } | null = null;
  for (const id of candidates.slice(0, 40)) {
    if (id === army.targetRegionId) continue;
    const r = routeFor(ctx, army.targetRegionId, id, false, units);
    if (r) {
      home = id;
      route = { path: [...r.path], cost: r.cost, usesSea: false };
      break;
    }
  }
  if (!home || !route) {
    await tx.update(armies).set({ status: "done", units: {}, cargo: {} }).where(eq(armies.id, army.id));
    await notify(tx, m.id, army.playerId, "system", `Stranded in ${where}: no ships left to carry them and no way home over land; ${count(units)} lost`, { regionId: army.targetRegionId, units });
    return null;
  }
  // The regions they must cross that nobody friendly holds.
  const crossing = route.path.slice(1, -1);
  const owners = crossing.length ? await tx.select({ regionId: matchRegions.regionId, owner: matchRegions.ownerPlayerId }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, crossing))) : [];
  const ownerOf = new Map(owners.map((r) => [r.regionId, r.owner]));
  const hostile = crossing.filter((id) => !friendlyOwners.has(ownerOf.get(id) ?? ""));
  let left: UnitCounts = { ...units };
  const caughtIn: string[] = [];
  for (const id of hostile) {
    if (count(left) === 0 || Math.random() >= t.strandedCatchPerRegion) continue;
    const next: UnitCounts = {};
    for (const [u, n] of Object.entries(left)) next[u] = n - Math.ceil(n * t.strandedLossShare);
    left = next;
    caughtIn.push(regionById(id)?.name ?? id);
  }
  const lost = count(units) - count(left);
  const homeName = regionById(home)?.name ?? home;
  const note = `No ships left: walking home to ${homeName} over land${hostile.length ? ` through ${hostile.length} foreign region${hostile.length === 1 ? "" : "s"}` : ""}${lost ? `; caught in ${caughtIn.join(", ")}, ${lost} killed or taken` : ""}`;
  await notify(tx, m.id, army.playerId, "system", `${note}.`, { regionId: army.targetRegionId, units: left });
  return { route, home, units: left, note };
}

async function comeHome(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  // Lock origin (and the capital as a fallback home) in ascending region order, like every other transaction.
  const [p] = await tx.select({ capital: players.capitalRegionId }).from(players).where(eq(players.id, army.playerId)).limit(1);
  const fallback = p?.capital && p.capital !== army.originRegionId ? p.capital : null;
  const ids = fallback ? [army.originRegionId, fallback].sort() : [army.originRegionId];
  const locked = new Map<string, MatchRegionRow>();
  for (const id of ids) locked.set(id, await lockRegion(tx, m, id, at));
  let home = locked.get(army.originRegionId)!;
  if (home.ownerPlayerId !== army.playerId && fallback) home = locked.get(fallback)!;
  const [owner] = await tx.select({ hidden: players.hidden }).from(players).where(eq(players.id, army.playerId)).limit(1);
  if (owner?.hidden) {
    // The horde camps where it came from: its fighters become that neutral region's defenders.
    if (!home.ownerPlayerId) await depositInto(tx, home, army.units, {});
    await tx.update(armies).set({ status: "done" }).where(eq(armies.id, army.id));
    return;
  }
  if (home.ownerPlayerId === army.playerId) {
    await depositInto(tx, home, army.units, army.cargo);
    await notify(tx, m.id, army.playerId, "system", `Army returned to ${regionById(home.regionId)?.name}`, { regionId: home.regionId, units: army.units, cargo: army.cargo });
  } else {
    await notify(tx, m.id, army.playerId, "system", "An army came home to find no friendly region and disbanded", { units: army.units });
  }
  await tx.update(armies).set({ status: "done" }).where(eq(armies.id, army.id));
  const pid = army.playerId;
  after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id }));
}

/** Add units, people and cargo into a locked, settled row. */
async function depositInto(tx: Tx, row: MatchRegionRow, units: UnitCounts, cargo: Record<string, number>): Promise<void> {
  const special = { ...emptySpecial(), ...(row.special as Record<string, number>) };
  const effects = effectsOf(row.buildings);
  const cap = storageCaps(effects, row.isCapital);
  const set: Partial<MatchRegionRow> = {
    units: addUnits(row.units, units),
    popSoldiers: row.popSoldiers + sumUnits(units),
    popWorkers: row.popWorkers + (cargo.people ?? 0),
  };
  for (const r of BASE) set[r] = Math.min(cap[r], row[r] + (cargo[r] ?? 0));
  for (const s of SPECIAL) special[s] = Math.min(balance.economy.specialStorage, (special[s] ?? 0) + (cargo[s] ?? 0));
  set.special = special;
  await tx.update(matchRegions).set(set).where(and(eq(matchRegions.matchId, row.matchId), eq(matchRegions.regionId, row.regionId)));
}

async function deliverUnits(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const friendly = target.ownerPlayerId === army.playerId || (target.ownerPlayerId ? await areAllied(tx, m.id, army.playerId, target.ownerPlayerId) : false);
  if (!friendly) {
    await notify(tx, m.id, army.playerId, "system", `${regionById(army.targetRegionId)?.name} is no longer friendly; the army is coming back`, { regionId: army.targetRegionId });
    return sendHome(tx, m, army, at, army.units, army.cargo, `${regionById(army.targetRegionId)?.name} is no longer friendly`);
  }
  // Settlers arriving in one of my conquered regions settle in as occupiers.
  const { settler: settlersArriving = 0, ...rest } = army.units;
  const joinAsOccupiers = settlersArriving > 0 && target.conquered && target.ownerPlayerId === army.playerId;
  await depositInto(tx, target, joinAsOccupiers ? rest : army.units, army.cargo);
  // People moving back into an evacuated region make it a home again.
  if (target.evacuatedAt && ((army.cargo.people ?? 0) > 0 || settlersArriving > 0)) {
    await tx.update(matchRegions).set({ evacuatedAt: null }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, army.targetRegionId)));
  }
  if (joinAsOccupiers) {
    await tx
      .update(matchRegions)
      .set({ popOccupiers: sql`${matchRegions.popOccupiers} + ${settlersArriving}` })
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, army.targetRegionId)));
  }
  await tx.update(armies).set({ status: "done" }).where(eq(armies.id, army.id));
  await notify(tx, m.id, army.playerId, "system", `${joinAsOccupiers ? `${settlersArriving} settlers joined the occupiers in` : "Troops arrived in"} ${regionById(army.targetRegionId)?.name}`, { regionId: army.targetRegionId, units: army.units });
  if (target.ownerPlayerId && target.ownerPlayerId !== army.playerId) {
    await notify(tx, m.id, target.ownerPlayerId, "alliance", `${await playerName(tx, army.playerId)} reinforced ${regionById(army.targetRegionId)?.name}`, { regionId: army.targetRegionId });
    // Everything handed to another account is on the ledger the fair-play scan reads: goods as they are, units at what they cost, people at a flat worth.
    const { transfers } = await import("../db/schema.js");
    const rows: Array<{ resource: string; amount: number }> = [];
    for (const [k, v] of Object.entries(army.cargo)) if (k !== "people" && v > 0) rows.push({ resource: k, amount: v });
    if ((army.cargo.people ?? 0) > 0) rows.push({ resource: "people", amount: (army.cargo.people ?? 0) * 50 });
    for (const [id, n] of Object.entries(army.units)) {
      const cost = unitById.get(id)?.cost ?? {};
      const worth = Object.values(cost).reduce((a, b) => a + (b ?? 0), 0);
      if (n > 0 && worth > 0) rows.push({ resource: `unit:${id}`, amount: n * worth });
    }
    for (const r of rows) await tx.insert(transfers).values({ matchId: m.id, fromPlayerId: army.playerId, toPlayerId: target.ownerPlayerId, resource: r.resource, amount: r.amount, via: "reinforce", at });
  }
  const pid = army.playerId;
  after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id }));
  if (target.ownerPlayerId && target.ownerPlayerId !== pid) {
    const owner = target.ownerPlayerId;
    after(() => publisher.toPlayer(m.id, owner, "region.updated", { regionId: army.targetRegionId }));
  }
}

/**
 * A land convoy that crossed unfriendly ground on this leg (regions neither its player's nor an ally's) may have been
 * ambushed: for each such region entered by land, before the last, balance.travel.roadAmbushPerRegion of the time it
 * loses roadAmbushLoss of its haulers and of every load aboard. What a materials route loaded and lost comes off that
 * route's total, so the order it was for is sourced again. The player is told. Returns the army as it arrives.
 */
async function roadAmbush(tx: Tx, m: MatchRow, army: ArmyRow, at: Date): Promise<ArmyRow> {
  const t = balance.travel;
  const haulers = Object.entries(army.units).some(([id, n]) => n > 0 && unitById.get(id)?.hauler && !unitById.get(id)?.naval);
  if (!haulers || army.path.length < 3) return army;
  const entered = army.path.slice(1, -1).filter((id, i) => regionById(army.path[i]!)?.neighbors.includes(id));
  if (!entered.length) return army;
  const friendly = await landableFor(tx, m.id, army.playerId);
  const hostile = entered.filter((id) => !friendly(id));
  let keep = 1;
  const where: string[] = [];
  for (const id of hostile) {
    if (Math.random() >= t.roadAmbushPerRegion) continue;
    keep *= 1 - t.roadAmbushLoss;
    where.push(regionById(id)?.name ?? id);
  }
  if (keep === 1) return army;
  const scale = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.floor(v * keep)]));
  const units = scale(army.units);
  const cargo = scale(army.cargo);
  const stops = army.stops.map((s) => (s.done && s.routeId ? { ...s, take: scale(s.take) } : s));
  // Goods a materials route loaded and lost: off its total, so its order is sourced again.
  for (const [i, s] of army.stops.entries()) {
    if (!s.done || !s.routeId) continue;
    const lost: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.take)) if (v - (stops[i]!.take[k] ?? 0) > 0) lost[k] = v - (stops[i]!.take[k] ?? 0);
    if (!Object.keys(lost).length) continue;
    const [r] = await tx.select().from(tradeRoutes).where(eq(tradeRoutes.id, s.routeId)).for("update");
    if (!r?.target) continue;
    const target = { ...r.target };
    for (const [k, v] of Object.entries(lost)) target[k] = Math.max(0, (target[k] ?? 0) - v);
    await tx.update(tradeRoutes).set({ target, load: target }).where(eq(tradeRoutes.id, r.id));
  }
  const lostHaulers = sumUnits(army.units) - sumUnits(units);
  const lostGoods = Object.values(army.cargo).reduce((a, b) => a + b, 0) - Object.values(cargo).reduce((a, b) => a + b, 0) + army.stops.reduce((a, s, i) => a + Object.values(s.take).reduce((x, y) => x + y, 0) - Object.values(stops[i]!.take).reduce((x, y) => x + y, 0), 0);
  await notify(tx, m.id, army.playerId, "system", `Your convoy to ${regionById(army.targetRegionId)?.name ?? army.targetRegionId} was ambushed in ${where.join(", ")}: ${lostHaulers} hauler${lostHaulers === 1 ? "" : "s"} and ${Math.round(lostGoods).toLocaleString("en-US")} goods lost on strangers' land`, { regionId: army.targetRegionId });
  await tx.update(armies).set({ units, cargo, stops }).where(eq(armies.id, army.id));
  return { ...army, units, cargo, stops };
}

async function deliverCargo(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  army = await roadAmbush(tx, m, army, at);
  if (sumUnits(army.units) === 0) {
    await tx.update(armies).set({ status: "done" }).where(eq(armies.id, army.id));
    return;
  }
  // A collecting convoy: at a pickup, load what the materials route there set aside and head for the next stop.
  if (army.stops.length) {
    const stops = army.stops.map((s) => ({ ...s }));
    const idx = stops.findIndex((s) => !s.done && s.regionId === army.targetRegionId);
    if (idx >= 0) {
      const cur = stops[idx]!;
      cur.done = true;
      const cargo = { ...army.cargo };
      if (cur.routeId) {
        const here = await lockRegion(tx, m, cur.regionId, at);
        // The goods were set aside here; if the region is no longer ours they are gone with it.
        if (here.ownerPlayerId === army.playerId) for (const [k, v] of Object.entries(cur.take)) cargo[k] = (cargo[k] ?? 0) + v;
        else cur.take = {};
      }
      const next = stops.find((s) => !s.done);
      if (next) {
        const { tradeRoutes } = await import("../db/schema.js");
        const ctx = await legContextFor(tx, m.id, army.playerId);
        const route = routeFor(ctx, cur.regionId, next.regionId, pathUsesSea(army.path), army.units) ?? { path: [cur.regionId, next.regionId], cost: 1000, usesSea: false };
        const seconds = await legSeconds(tx, m, ctx, route, army.units, at);
        const arrivesAt = new Date(at.getTime() + seconds * 1000);
        await tx.update(armies).set({ cargo, stops, targetRegionId: next.regionId, path: route.path, departsAt: at, arrivesAt }).where(eq(armies.id, army.id));
        await tx.insert(jobs).values({ matchId: m.id, playerId: army.playerId, regionId: next.regionId, kind: "mission", refId: army.id, startsAt: at, endsAt: arrivesAt });
        void tradeRoutes;
        const pid = army.playerId;
        after(() => publisher.toPlayer(m.id, pid, "army.sent", { armyId: army.id, collecting: cur.regionId }));
        return;
      }
      // The destination: credit each materials route with what the convoy took from it, and retire the ones that are complete.
      // Goods bound for a further shore are handed over here, into the next leg's route, and never touch the stores.
      const { tradeRoutes } = await import("../db/schema.js");
      const relayed: Record<string, number> = {};
      for (const s of stops) {
        if (!s.routeId) continue;
        const [r] = await tx.select().from(tradeRoutes).where(eq(tradeRoutes.id, s.routeId)).for("update");
        if (!r) continue;
        const delivered = { ...r.delivered };
        for (const [k, v] of Object.entries(s.take)) delivered[k] = (delivered[k] ?? 0) + v;
        if (r.relayTo && r.relayTo !== r.toRegionId && (await handOver(tx, m, army.playerId, r, s.take, at))) {
          for (const [k, v] of Object.entries(s.take)) relayed[k] = (relayed[k] ?? 0) + v;
        }
        const done = !!r.target && Object.entries(r.target).every(([k, v]) => (delivered[k] ?? 0) >= v - 0.5);
        if (done) await tx.delete(tradeRoutes).where(eq(tradeRoutes.id, r.id));
        else await tx.update(tradeRoutes).set({ delivered }).where(eq(tradeRoutes.id, r.id));
      }
      for (const [k, v] of Object.entries(relayed)) cargo[k] = Math.max(0, (cargo[k] ?? 0) - v);
      army = { ...army, cargo, stops };
      await tx.update(armies).set({ cargo, stops }).where(eq(armies.id, army.id));
    }
  }
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const friendly = target.ownerPlayerId === army.playerId || (target.ownerPlayerId ? await areAllied(tx, m.id, army.playerId, target.ownerPlayerId) : false);
  if (!friendly) {
    await notify(tx, m.id, army.playerId, "trade", `${regionById(army.targetRegionId)?.name} is no longer friendly; the goods are coming back`, { regionId: army.targetRegionId });
    return sendHome(tx, m, army, at, army.units, army.cargo, `${regionById(army.targetRegionId)?.name} is no longer friendly`);
  }
  const { people: _people, ...goods } = army.cargo;
  if (target.ownerPlayerId === army.playerId) {
    // Materials for waiting builds are applied first, outside the storage cap; the rest is stored.
    const { rest, started } = await receiveMaterials(tx, m, army.targetRegionId, goods, at);
    await depositInto(tx, target, {}, { ...rest, people: army.cargo.people ?? 0 });
    if (started) await notify(tx, m.id, army.playerId, "build", `Materials arrived in ${regionById(army.targetRegionId)?.name}: ${started} build${started === 1 ? "" : "s"} started`, { regionId: army.targetRegionId });
  } else {
    await depositInto(tx, target, {}, army.cargo);
  }
  if (target.ownerPlayerId && target.ownerPlayerId !== army.playerId) {
    const { transfers } = await import("../db/schema.js");
    for (const [k, v] of Object.entries(goods)) {
      if (v > 0) await tx.insert(transfers).values({ matchId: m.id, fromPlayerId: army.playerId, toPlayerId: target.ownerPlayerId, resource: k, amount: v, via: "transport", at });
    }
    await notify(tx, m.id, target.ownerPlayerId, "trade", `${await playerName(tx, army.playerId)} delivered goods to ${regionById(army.targetRegionId)?.name}`, { regionId: army.targetRegionId, cargo: goods });
  }
  await notify(tx, m.id, army.playerId, "trade", `Goods delivered to ${regionById(army.targetRegionId)?.name}`, { regionId: army.targetRegionId, cargo: goods });
  // A convoy that finds the region it served at its cap carries the overflow on to the capital instead of walking home empty.
  if (!(await carryOverflowOn(tx, m, army, at))) await sendHome(tx, m, army, at, army.units, {});
  const pid = army.playerId;
  after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id }));
}

/**
 * The hand-over at a harbour: what a convoy brought for a further shore goes into the route for the next leg (a ship
 * across the lane, or a land hauler on from the far harbour), created here if it does not exist yet, so the next
 * dispatch carries it on. Returns false when there is no way on, in which case the goods are simply delivered here.
 */
async function handOver(tx: Tx, m: MatchRow, playerId: string, r: { id: string; toRegionId: string; relayTo: string | null; forJobId: string | null }, take: Record<string, number>, at: Date): Promise<boolean> {
  const next = nextHopTo(r.toRegionId, r.relayTo!, await landableFor(tx, m.id, playerId), await sailsFor(tx, m.id, playerId));
  if (!next) return false;
  const { tradeRoutes } = await import("../db/schema.js");
  const ctx = await legContextFor(tx, m.id, playerId);
  const total = Object.values(take).reduce((a, b) => a + b, 0);
  if (total < 1) return false;
  // Over the lane the leg is by ship; otherwise by land hauler.
  const byShip = next.bySea;
  const caravans = Math.max(1, Math.min(balance.trade.maxSupplyCaravans, Math.ceil(total / haulerCarry(byShip ? "cog" : "caravan", ctx.techs))));
  const [existing] = await tx
    .select()
    .from(tradeRoutes)
    .where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.playerId, playerId), eq(tradeRoutes.fromRegionId, r.toRegionId), eq(tradeRoutes.toRegionId, next.hop), sql`coalesce(${tradeRoutes.relayTo}, ${tradeRoutes.toRegionId}) = ${r.relayTo}`, sql`${tradeRoutes.forJobId} is not distinct from ${r.forJobId}`))
    .limit(1)
    .for("update");
  if (existing) {
    const target = { ...(existing.target ?? {}) };
    const held = { ...existing.held };
    for (const [k, v] of Object.entries(take)) {
      target[k] = (target[k] ?? 0) + v;
      held[k] = (held[k] ?? 0) + v;
    }
    await tx.update(tradeRoutes).set({ target, load: target, held, caravans: Math.max(existing.caravans, caravans), nextAt: at }).where(eq(tradeRoutes.id, existing.id));
  } else {
    await tx.insert(tradeRoutes).values({ matchId: m.id, playerId, fromRegionId: r.toRegionId, toRegionId: next.hop, relayTo: r.relayTo, mode: "fixed", load: take, share: 0, caravans, everyHours: 1, target: take, delivered: {}, held: take, nextAt: at, forJobId: r.forJobId });
  }
  return true;
}

/**
 * Return trips carry: a convoy that has just delivered to one of its owner's regions, finding that region at its cap for
 * food, wood or stone, loads the overflow (the same share the overflow pass would send) and goes on to the capital,
 * walking home from there. One overflow convoy per region at a time and none within overflowEveryHours of the last,
 * as the overflow pass keeps it. Returns false when there is nothing to carry.
 */
async function carryOverflowOn(tx: Tx, m: MatchRow, army: ArmyRow, at: Date): Promise<boolean> {
  if (!balance.trade.overflowToCapital || haulerCount(army.units) === 0) return false;
  const [p] = await tx.select({ capital: players.capitalRegionId }).from(players).where(eq(players.id, army.playerId)).limit(1);
  const capital = p?.capital;
  if (!capital || capital === army.targetRegionId) return false;
  const [row] = await tx.select().from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, army.targetRegionId))).limit(1);
  if (!row || row.ownerPlayerId !== army.playerId || row.isCapital || row.frozenAt) return false;
  const recentCutoff = new Date(at.getTime() - (balance.trade.overflowEveryHours * 3600_000) / m.speed);
  const [busy] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, army.playerId), eq(armies.mission, "transport"), eq(armies.originRegionId, army.targetRegionId), sql`${armies.id} <> ${army.id}`, sql`(${armies.status} = 'outbound' or ${armies.departsAt} > ${recentCutoff.toISOString()}::timestamptz)`));
  if ((busy?.n ?? 0) > 0) return false;
  const fx = await ownerTechEffects(tx, army.playerId);
  const caps = storageCaps(applyTechEffects(effectsOf(row.buildings), fx), false);
  const cargo: Record<string, number> = {};
  for (const r of BASE) if (row[r] >= caps[r] * 0.98) cargo[r] = Math.floor(caps[r] * balance.trade.overflowShare);
  let total = Object.values(cargo).reduce((a, b) => a + b, 0);
  if (total < 1) return false;
  const ctx = await legContextFor(tx, m.id, army.playerId);
  const capacity = carryCapacity(army.units, ctx.techs);
  if (capacity < 1) return false;
  if (total > capacity) {
    const f = capacity / total;
    for (const k of Object.keys(cargo)) cargo[k] = Math.floor(cargo[k]! * f);
    total = Object.values(cargo).reduce((a, b) => a + b, 0);
    if (total < 1) return false;
  }
  const route = routeFor(ctx, army.targetRegionId, capital);
  if (!route) return false;
  const set: Partial<MatchRegionRow> = {};
  for (const r of BASE) if (cargo[r]) set[r] = Math.max(0, row[r] - cargo[r]!);
  await tx.update(matchRegions).set(set).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, row.regionId)));
  const seconds = await legSeconds(tx, m, ctx, route, army.units, at);
  const arrivesAt = new Date(at.getTime() + seconds * 1000);
  // The haulers go on as a fresh transport from here, so afterwards they walk home from the capital to this region.
  await tx.update(armies).set({ status: "done", units: {}, cargo: {} }).where(eq(armies.id, army.id));
  const [next] = await tx
    .insert(armies)
    .values({ matchId: m.id, playerId: army.playerId, mission: "transport", originRegionId: row.regionId, targetRegionId: capital, units: army.units, cargo: { ...cargo, people: 0 }, path: route.path, status: "outbound", departsAt: at, arrivesAt })
    .returning({ id: armies.id });
  await tx.insert(jobs).values({ matchId: m.id, playerId: army.playerId, regionId: capital, kind: "mission", refId: next!.id, startsAt: at, endsAt: arrivesAt });
  await notify(tx, m.id, army.playerId, "trade", `${regionById(row.regionId)?.name} is full: the convoy carries ${Object.entries(cargo).map(([k, v]) => `${v} ${k}`).join(", ")} on to the capital`, { regionId: row.regionId });
  return true;
}

/** One line of what a scout saw: owner, people, soldiers and the defences. */
export function describeSighting(s: { ownerName: string | null; population: number; units: Record<string, number>; buildings: Record<string, number>; frozen: boolean }): string {
  const soldiers = Object.entries(s.units).reduce((a, [id, n]) => a + (unitById.get(id)?.civilian ? 0 : n), 0);
  const defences = Object.entries(s.buildings)
    .filter(([id]) => (buildingById.get(id)?.effect.defense ?? 0) > 0)
    .map(([id, lvl]) => `${buildingById.get(id)?.name ?? id} ${lvl}`)
    .join(", ");
  return `Scouted: ${s.frozen ? "frozen, " : ""}${s.ownerName ? `held by ${s.ownerName}` : "nobody's"}, ${s.population} people, ${soldiers} soldiers${defences ? `, ${defences}` : ""}.`;
}

/** Add a dated line to a player's notes on a region (creating the note), keeping the newest lines when it grows long. */
export async function appendRegionNote(tx: Tx, m: MatchRow, playerId: string, regionId: string, at: Date, line: string): Promise<void> {
  const { regionNotes } = await import("../db/schema.js");
  const day = Math.floor(matchDayAt(m, at)) + 1;
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  const stamped = `[Day ${day} · ${hh}:${mm} UTC] ${line}`;
  const [cur] = await tx.select().from(regionNotes).where(and(eq(regionNotes.matchId, m.id), eq(regionNotes.playerId, playerId), eq(regionNotes.regionId, regionId))).limit(1);
  let text = cur?.text ? `${cur.text}\n${stamped}` : stamped;
  const lines = text.split("\n");
  while (text.length > 1500 && lines.length > 1) {
    lines.shift();
    text = lines.join("\n");
  }
  await tx
    .insert(regionNotes)
    .values({ matchId: m.id, playerId, regionId, text, colour: null, updatedAt: at })
    .onConflictDoUpdate({ target: [regionNotes.matchId, regionNotes.playerId, regionNotes.regionId], set: { text, updatedAt: at } });
}

async function scout(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const ownerName = target.ownerPlayerId ? await playerName(tx, target.ownerPlayerId) : null;
  const name = regionById(army.targetRegionId)?.name ?? army.targetRegionId;
  const pid = army.playerId;

  // The risk: in a held or garrisoned region each scout may be caught. Friends never catch you. The roll is seeded, so a replay agrees.
  const friendly = !!target.ownerPlayerId && (target.ownerPlayerId === army.playerId || (await areAllied(tx, m.id, army.playerId, target.ownerPlayerId)));
  const sent = sumUnits(army.units);
  let caught = 0;
  if (!friendly && sent > 0) {
    let watchtower = effectsOf(target.buildings).watchtower;
    if (!watchtower && target.ownerPlayerId) {
      const near = regionById(army.targetRegionId)?.neighbors ?? [];
      if (near.length) {
        const rows = await tx
          .select({ buildings: matchRegions.buildings })
          .from(matchRegions)
          .where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, near), eq(matchRegions.ownerPlayerId, target.ownerPlayerId)));
        watchtower = rows.some((r) => effectsOf(r.buildings).watchtower);
      }
    }
    if (isAirGroup(army.units)) {
      // Nobody on the ground catches a plane; a battery shoots a share down.
      caught = Math.round(sent * Math.min(balance.combat.antiAirMax, effectsOf(target.buildings).antiAir));
    } else {
      const chance = scoutCatchChance({ held: !!target.ownerPlayerId, soldiers: soldierCount(target.units), watchtower, wall: wallOf(target.buildings) !== null });
      if (chance > 0) {
        const rng = seededRng(`${m.seed}:scout:${army.id}`);
        for (let i = 0; i < sent; i++) if (rng() < chance) caught += 1;
      }
    }
  }
  if (caught >= sent && sent > 0) {
    // Nobody made it: no report, and both sides hear of it.
    const scoutName = await playerName(tx, army.playerId);
    await notify(tx, m.id, army.playerId, "scout", `${sent === 1 ? "Your scout" : `Your ${sent} scouts`} to ${name} never returned`, { regionId: army.targetRegionId, caught: sent });
    await appendRegionNote(tx, m, army.playerId, army.targetRegionId, at, `${sent === 1 ? "A scout" : `${sent} scouts`} sent here never returned.`);
    if (target.ownerPlayerId) await notify(tx, m.id, target.ownerPlayerId, "scout", `${sent === 1 ? "An enemy scout" : `${sent} enemy scouts`} from ${scoutName} ${sent === 1 ? "was" : "were"} caught in ${name}`, { regionId: army.targetRegionId, caught: sent });
    await tx.insert(events).values({ matchId: m.id, at, kind: "scout.caught", payload: { playerId: army.playerId, regionId: army.targetRegionId, caught: sent, ownerPlayerId: target.ownerPlayerId } });
    await tx.update(armies).set({ status: "done", units: {} }).where(eq(armies.id, army.id));
    after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id }));
    return;
  }
  const survivors: UnitCounts = {};
  if (caught > 0) {
    // Losses come off the party; the report is filed by whoever got through.
    let left = caught;
    for (const [id, q] of Object.entries(army.units)) {
      const take = Math.min(q, left);
      left -= take;
      if (q - take > 0) survivors[id] = q - take;
    }
  }
  const snapshot = {
    ownerPlayerId: target.ownerPlayerId,
    ownerName,
    population: Math.round(target.popWorkers + target.popSoldiers + target.popOccupiers),
    units: target.units,
    buildings: target.buildings,
    frozen: target.frozenAt !== null,
  };
  await tx
    .insert(regionSightings)
    .values({ matchId: m.id, playerId: army.playerId, regionId: army.targetRegionId, seenAt: at, snapshot })
    .onConflictDoUpdate({ target: [regionSightings.matchId, regionSightings.playerId, regionSightings.regionId], set: { seenAt: at, snapshot } });
  const lost = caught > 0 ? `; ${caught} of ${sent} did not make it` : "";
  await notify(tx, m.id, army.playerId, "scout", `Scout report: ${name}${lost}`, { regionId: army.targetRegionId, caught, ...snapshot });
  // The report also goes into the scout's own notes on the region, dated, so what was learned keeps its moment even after things change there.
  await appendRegionNote(tx, m, army.playerId, army.targetRegionId, at, describeSighting(snapshot) + (caught > 0 ? ` ${caught} of ${sent} scouts were caught.` : ""));
  if (target.ownerPlayerId && target.ownerPlayerId !== army.playerId) {
    await notify(tx, m.id, target.ownerPlayerId, "scout", `Scouts from ${await playerName(tx, army.playerId)} were seen in ${name}${caught > 0 ? `; ${caught} caught` : ""}`, { regionId: army.targetRegionId, caught });
  }
  if (caught > 0) await tx.insert(events).values({ matchId: m.id, at, kind: "scout.caught", payload: { playerId: army.playerId, regionId: army.targetRegionId, caught, ownerPlayerId: target.ownerPlayerId } });
  await sendHome(tx, m, army, at, caught > 0 ? survivors : army.units, {});
  after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id }));
}

/** What a battle in progress shows: both sides at the start and now, the bonuses, the playback schedule and the log. */
export interface BattleLive {
  mission: "raid" | "conquer";
  attacker: { playerId: string; name: string; start: UnitCounts; now: UnitCounts };
  defender: { playerId: string | null; name: string; start: UnitCounts; now: UnitCounts };
  bonus: { attack: number; defense: number; wallFull: number; wallBonus: number; siege: number; terrain: number; militia: number };
  schedule: BattleRound[];
  log: Array<{ round: number; aLoss: UnitCounts; dLoss: UnitCounts; aLeft: number; dLeft: number }>;
}

/** The result decided on arrival, kept so the end of the playback applies it without recomputing anything. */
export interface BattleOutcome {
  result: CombatResult;
  settlersAlong: number;
  seed: string;
  wallFull: number;
  wallBonus: number;
  siege: number;
}

/** Real milliseconds between rounds of a battle's playback; BATTLE_ROUND_MS overrides (0 plays the whole battle at once, as the tests do). */
export function battleRoundMs(): number {
  const env = process.env.BATTLE_ROUND_MS;
  if (env !== undefined && env !== "") return Math.max(0, Number(env) || 0);
  return balance.battle.roundSeconds * 1000;
}

function takeLosses(now: UnitCounts, loss: UnitCounts): UnitCounts {
  const out = { ...now };
  for (const [k, v] of Object.entries(loss)) out[k] = Math.max(0, (out[k] ?? 0) - v);
  return out;
}

/** Play one scheduled round into the live picture. */
function applyRound(live: BattleLive, round: number): void {
  const entry = live.schedule[round - 1];
  if (!entry) return;
  const [aLoss, dLoss] = entry;
  live.attacker.now = takeLosses(live.attacker.now, aLoss);
  live.defender.now = takeLosses(live.defender.now, dLoss);
  live.log.push({ round, aLoss, dLoss, aLeft: sumUnits(live.attacker.now), dLeft: sumUnits(live.defender.now) });
  if (live.log.length > 400) live.log.splice(0, live.log.length - 400);
}

/**
 * A raid or conquest arrives: the battle is decided here, exactly as it always was, and then played out in short
 * rounds (one or two units falling a round) that everyone in the match can watch. Nothing changes hands until the
 * last round; see finishBattle.
 */
async function battle(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const region = regionById(army.targetRegionId)!;
  const defenderId = target.ownerPlayerId;

  // The region became ours on the way (a capital fell and its realm came over): the force stays. Soldiers garrison it, settlers join the occupiers.
  if (defenderId === army.playerId) return deliverUnits(tx, m, army, at, publisher, after);
  // Attacking a friend (alliance formed mid-flight) is called off.
  if (defenderId && (await areAllied(tx, m.id, army.playerId, defenderId))) {
    await notify(tx, m.id, army.playerId, "battle", `Attack on ${region.name} called off: the region is friendly`, { regionId: region.id });
    return sendHome(tx, m, army, at, army.units, army.cargo, "called off: the region is now friendly");
  }

  const effects = effectsOf(target.buildings);
  const militia = Math.floor(((target.popWorkers + target.popOccupiers) / 10) * balance.combat.militiaPerTenPeople);
  // Everyone standing in the region defends it, settlers included, except the haulers: caravans, wagons, trains and cogs stay out of the fight and untouched.
  const standing: UnitCounts = {};
  for (const [id, n] of Object.entries(target.units)) if (n > 0 && !unitById.get(id)?.hauler) standing[id] = n;
  const defenderUnits: UnitCounts = militia > 0 ? addUnits(standing, { militia }) : standing;
  const attackerTech = await ownerTechEffects(tx, army.playerId);
  const defenderTech = await ownerTechEffects(tx, target.ownerPlayerId);
  const seed = `${m.seed}:${army.id}:${at.getTime()}`;
  // Settlers travelling with a conquest wait behind the lines; they occupy if the battle is won and retreat with the survivors if it is lost.
  const { settler: settlersAlong = 0, ...fighting } = army.units;
  // Walls are near-impregnable to men alone; siege engines bring the wall bonus down. Techs and terrain always count.
  const wallFull = Object.keys(balance.combat.wallBreach).reduce((a, id) => a + (buildingById.get(id)?.effect.defense ?? 0) * (target.buildings[id] ?? 0), 0);
  const wallBonus = wallBonusAgainst(target.buildings, fighting);
  const terrain = balance.combat.terrainDefense[region.terrain] ?? 0;
  const bonus = effects.defense - wallFull + wallBonus + defenderTech.defense + terrain;
  const result = resolveCombat({ units: fighting, bonus: attackerTech.attack }, { units: defenderUnits, bonus }, seed);

  const attackerName = await playerName(tx, army.playerId);
  const defenderName = defenderId ? await playerName(tx, defenderId) : "Neutral tribes";
  const schedule = battleSchedule(result.attackerLosses, result.defenderLosses, seed);
  const live: BattleLive = {
    mission: army.mission as "raid" | "conquer",
    attacker: { playerId: army.playerId, name: attackerName, start: { ...fighting }, now: { ...fighting } },
    defender: { playerId: defenderId, name: defenderName, start: { ...defenderUnits }, now: { ...defenderUnits } },
    bonus: { attack: attackerTech.attack, defense: bonus, wallFull, wallBonus, siege: breachOf(fighting), terrain, militia },
    schedule,
    log: [],
  };
  const outcome: BattleOutcome = { result, settlersAlong, seed, wallFull, wallBonus, siege: breachOf(fighting) };
  const roundMs = battleRoundMs();
  const [row] = await tx
    .insert(battles)
    .values({ matchId: m.id, regionId: army.targetRegionId, resolvedAt: at, seed, attackerPlayerId: army.playerId, defenderPlayerId: defenderId, report: {}, status: "fighting", startedAt: at, armyId: army.id, round: 0, totalRounds: schedule.length, nextRoundAt: schedule.length ? new Date(at.getTime() + roundMs) : null, live, outcome })
    .returning();
  if (roundMs === 0 || schedule.length === 0) {
    // Nothing to watch (or the tests): the whole fight plays out now.
    for (let r = 1; r <= schedule.length; r++) applyRound(live, r);
    return finishBattle(tx, m, { ...row!, live, round: schedule.length }, army, at, publisher, after);
  }
  await tx.update(armies).set({ status: "fighting" }).where(eq(armies.id, army.id));
  await tx.insert(jobs).values({ matchId: m.id, playerId: army.playerId, regionId: army.targetRegionId, kind: "battle_round", refId: row!.id, startsAt: at, endsAt: new Date(at.getTime() + roundMs) });
  const battleId = row!.id;
  after(() => publisher.toMatch(m.id, "battle.started", { battleId, regionId: army.targetRegionId }));
}

/** One round of a battle's playback comes due: a unit or two fall on the live picture; the last round applies the result. */
export async function playBattleRound(tx: Tx, m: MatchRow, job: JobRow, publisher: Publisher, after: After): Promise<void> {
  if (!job.refId) throw new Error("battle round without a battle");
  const [b] = await tx.select().from(battles).where(eq(battles.id, job.refId)).for("update");
  if (!b || b.status !== "fighting" || !b.live || !b.armyId) return;
  const live = b.live as BattleLive;
  const round = b.round + 1;
  applyRound(live, round);
  if (round < b.totalRounds) {
    const nextRoundAt = new Date(job.endsAt.getTime() + battleRoundMs());
    await tx.update(battles).set({ live, round, nextRoundAt }).where(eq(battles.id, b.id));
    await tx.insert(jobs).values({ matchId: m.id, playerId: job.playerId, regionId: b.regionId, kind: "battle_round", refId: b.id, startsAt: job.endsAt, endsAt: nextRoundAt });
    const battleId = b.id;
    after(() => publisher.toMatch(m.id, "battle.round", { battleId, round, regionId: b.regionId }));
    return;
  }
  const [army] = await tx.select().from(armies).where(eq(armies.id, b.armyId)).for("update");
  if (!army) {
    await tx.update(battles).set({ status: "done", live, round, nextRoundAt: null }).where(eq(battles.id, b.id));
    return;
  }
  await finishBattle(tx, m, { ...b, live, round }, army, job.endsAt, publisher, after);
}

/** The last round is over: losses, loot, conquest, the report, messages and notes, and the army's road home, exactly as a battle always ended. */
async function finishBattle(tx: Tx, m: MatchRow, b: typeof battles.$inferSelect, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const live = b.live as BattleLive;
  const { result, settlersAlong, seed } = b.outcome as BattleOutcome;
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const region = regionById(army.targetRegionId)!;
  const defenderId = target.ownerPlayerId;
  const close = async (report: Record<string, unknown>) => {
    await tx.update(battles).set({ status: "done", report, live, round: b.totalRounds, nextRoundAt: null }).where(eq(battles.id, b.id));
    const battleId = b.id;
    after(() => publisher.toMatch(m.id, "battle.ended", { battleId, regionId: army.targetRegionId }));
  };

  // The region changed hands while the fight played out: ours now, or a friend's.
  if (defenderId === army.playerId) {
    await close({ regionName: region.name, regionId: region.id, mission: army.mission, attackerName: live.attacker.name, defenderName: live.defender.name, attackerWon: true, rounds: result.rounds, attacker: { before: army.units, losses: {} }, defender: { before: live.defender.start, losses: {} }, loot: {}, conquered: false, note: "the region was already ours" });
    return deliverUnits(tx, m, army, at, publisher, after);
  }
  if (defenderId && (await areAllied(tx, m.id, army.playerId, defenderId))) {
    await close({ regionName: region.name, regionId: region.id, mission: army.mission, attackerName: live.attacker.name, defenderName: live.defender.name, attackerWon: false, rounds: result.rounds, attacker: { before: army.units, losses: {} }, defender: { before: live.defender.start, losses: {} }, loot: {}, conquered: false, note: "called off" });
    await notify(tx, m.id, army.playerId, "battle", `Attack on ${region.name} called off: the region is friendly`, { regionId: region.id });
    return sendHome(tx, m, army, at, army.units, army.cargo, "called off: the region is now friendly");
  }

  const effects = effectsOf(target.buildings);
  const fighting = live.attacker.start;
  const defenderUnits = live.defender.start;
  const attackerName = live.attacker.name;
  const defenderName = defenderId ? await playerName(tx, defenderId) : "Neutral tribes";

  // Apply defender losses (militia losses cost population).
  const { militia: militiaLost = 0, ...unitLosses } = result.defenderLosses;
  const newDefUnits = { ...target.units };
  let defSoldierLoss = 0;
  for (const [k, v] of Object.entries(unitLosses)) {
    newDefUnits[k] = Math.max(0, (newDefUnits[k] ?? 0) - v);
    defSoldierLoss += v;
  }
  const set: Partial<MatchRegionRow> = {
    units: newDefUnits,
    popSoldiers: Math.max(0, target.popSoldiers - defSoldierLoss),
    popWorkers: Math.max(0, target.popWorkers - militiaLost * 10 * 0.5),
  };

  const survivors = result.attackerRemaining;
  let loot: Record<string, number> = {};
  let conquered = false;

  if (result.attackerWon && army.mission === "raid") {
    const capacity = carryCapacity(survivors);
    const unprotected: Record<string, number> = {};
    // Refused tribute is cause for war: double loot for a day.
    const war = defenderId ? await causeForWar(tx, m.id, army.playerId, defenderId, at) : false;
    const share = Math.min(1, balance.combat.raidShare * (war ? balance.events.diplomacy.lootMult : 1));
    for (const r of BASE) unprotected[r] = Math.max(0, target[r] - effects.protect) * share;
    const special: Record<string, number> = { ...emptySpecial(), ...(target.special as Record<string, number>) };
    for (const s of SPECIAL) unprotected[s] = (special[s] ?? 0) * share;
    const total = Object.values(unprotected).reduce((a, b) => a + b, 0);
    const take = Math.min(capacity, total);
    if (take > 0) {
      for (const [k, v] of Object.entries(unprotected)) {
        const amt = (v / total) * take;
        if (amt <= 0) continue;
        loot[k] = amt;
        if (k === "food" || k === "wood" || k === "stone") set[k] = target[k] - amt;
        else special[k] = (special[k] ?? 0) - amt;
      }
      set.special = special;
    }
  }

  if (result.attackerWon && army.mission === "conquer") {
    const occupiers = settlersAlong + (army.cargo.people ?? 0);
    if (occupiers >= balance.conquest.occupiersRequired) {
      conquered = true;
      await clearMilitaryTargets(tx, m.id, army.playerId, [army.targetRegionId]);
      Object.assign(set, {
        ownerPlayerId: army.playerId,
        isCapital: false,
        conquered: true,
        units: survivors,
        popSoldiers: sumUnits(survivors),
        popOccupiers: occupiers,
        loyalty: balance.conquest.startingLoyalty,
        assignment: { ...balance.start.assignment },
        food: Math.max((set.food as number | undefined) ?? target.food, balance.conquest.seedFood),
      });
      // The old owner's builds and training here are dropped by handleRegionLost below.
    }
  }

  await tx.update(matchRegions).set(set).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, army.targetRegionId)));

  const report = {
    walls: { bonus: Math.round(live.bonus.wallBonus * 100) / 100, full: Math.round(live.bonus.wallFull * 100) / 100, siege: breachOf(fighting) },
    regionName: region.name,
    regionId: army.targetRegionId,
    mission: army.mission,
    attackerName,
    defenderName,
    attackerWon: result.attackerWon,
    rounds: result.rounds,
    attacker: { before: army.units, losses: result.attackerLosses },
    defender: { before: defenderUnits, losses: result.defenderLosses },
    loot,
    conquered,
  };
  await close(report);
  if (result.attackerWon) await claimBounties(tx, m, army.playerId, army.targetRegionId, defenderId, at);
  // The tribes talk about it in the match chat when it mattered.
  const lossesAll = Object.values(result.attackerLosses).reduce((a, b) => a + b, 0) + Object.values(result.defenderLosses).reduce((a, b) => a + b, 0);
  await tribeBattleTalk(tx, m, { attackerId: army.playerId, defenderId, attackerName, defenderName, region: region.name, attackerWon: result.attackerWon, conquered, losses: lossesAll, seed }, at, publisher, after);
  const verb = army.mission === "raid" ? "Raid on" : "Attack on";
  await notify(tx, m.id, army.playerId, "battle", `${verb} ${region.name}: ${result.attackerWon ? "victory" : "defeat"}${conquered ? ", region conquered" : ""}`, { regionId: region.id, battleId: b.id, report });
  if (defenderId) await notify(tx, m.id, defenderId, "battle", `${attackerName} ${army.mission === "raid" ? "raided" : "attacked"} ${region.name}: ${result.attackerWon ? "they won" : "we held"}${conquered ? ", region lost" : ""}`, { regionId: region.id, battleId: b.id, report });
  // Both sides keep the battle in their notes on the region: what each brought, what it cost, how it ended.
  {
    const unitsText = (u: UnitCounts) =>
      Object.entries(u)
        .filter(([, n]) => n > 0)
        .map(([id, n]) => `${n} ${unitById.get(id)?.name ?? id}`)
        .join(", ") || "nothing";
    const lost = (u: UnitCounts) => Object.values(u).reduce((a, b) => a + b, 0);
    const verb = army.mission === "raid" ? "raided" : "attacked";
    const outcome = conquered ? "the region was taken" : result.attackerWon ? "the attackers won" : "the defenders held";
    const line = `Battle: ${attackerName} ${verb} with ${unitsText(army.units)} against ${defenderName}'s ${unitsText(defenderUnits)}; ${outcome}. Attackers lost ${lost(result.attackerLosses)}, defenders ${lost(result.defenderLosses)}.`;
    await appendRegionNote(tx, m, army.playerId, army.targetRegionId, at, line);
    if (defenderId) await appendRegionNote(tx, m, defenderId, army.targetRegionId, at, line);
  }

  if (conquered) {
    await tx.update(armies).set({ status: "done", units: survivors }).where(eq(armies.id, army.id));
    if (defenderId) await handleRegionLost(tx, m, defenderId, army.targetRegionId, at, army.playerId);
  } else {
    await sendHome(tx, m, army, at, settlersAlong > 0 ? { ...survivors, settler: settlersAlong } : survivors, { ...loot, people: army.cargo.people ?? 0 });
  }

  const pid = army.playerId;
  after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id, won: result.attackerWon }));
  if (defenderId) {
    const d = defenderId;
    after(() => publisher.toPlayer(m.id, d, conquered ? "region.conquered" : "region.updated", { regionId: army.targetRegionId }));
  }
  if (conquered) after(() => publisher.toMatch(m.id, "region.conquered", { regionId: army.targetRegionId, by: pid }));
}

/** A player lost a region: move the capital if needed, eliminate if nothing is left. A capital taken by a player hands them the whole realm. */
export async function handleRegionLost(tx: Tx, m: MatchRow, playerId: string, regionId: string, at: Date, byPlayerId: string | null = null): Promise<void> {
  const [p] = await tx.select().from(players).where(eq(players.id, playerId)).for("update");
  if (!p) return;
  await dropLostJobs(tx, m, playerId, regionId, at);
  // Nor is it on any advisor's list of regions to leave alone any more.
  await tx.execute(sql`update ${advisors} set settings = jsonb_set(settings, '{skipRegions}', (settings->'skipRegions') - ${regionId}) where match_id = ${m.id} and player_id = ${playerId} and settings->'skipRegions' ? ${regionId}`);
  const remaining = await tx
    .select({ regionId: matchRegions.regionId, pop: matchRegions.popWorkers })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId)));
  if (remaining.length === 0) {
    if (!p.eliminatedAt) {
      await tx.update(players).set({ eliminatedAt: at, capitalRegionId: null }).where(eq(players.id, playerId));
      await notify(tx, m.id, playerId, "system", "Your last region has fallen. You can watch the rest of the match and join the next one.", {});
    }
    return;
  }
  if (p.capitalRegionId === regionId) {
    // Lose the capital, lose the game. Taken by a player, the whole realm goes to them; frozen or rebelled, it falls apart into neutral tribes.
    await eliminatePlayer(tx, m, playerId, at, `Your capital, ${regionById(regionId)?.name ?? regionId}, has fallen. The realm is lost.`, byPlayerId);
  }
}

/**
 * A region is no longer the player's (taken, rebelled, given up): every build and training they had queued there is
 * cancelled at once, and the materials set aside for them at other regions go back on those regions' shelves (when
 * still the player's), the materials routes dropped. Nothing is refunded at the lost region itself. Returns how many
 * were cancelled.
 */
export async function dropLostJobs(tx: Tx, m: MatchRow, playerId: string, regionId: string, at: Date): Promise<number> {
  const open = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, playerId), eq(jobs.regionId, regionId), inArray(jobs.kind, ["build", "train"]), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
  if (!open.length) return 0;
  const ids = open.map((j) => j.id);
  await tx.update(jobs).set({ cancelledAt: at }).where(inArray(jobs.id, ids));
  const routes = await tx.select().from(tradeRoutes).where(and(eq(tradeRoutes.matchId, m.id), inArray(tradeRoutes.forJobId, ids))).for("update");
  for (const r of routes) {
    const held = Object.fromEntries(Object.entries(r.held).filter(([, v]) => v > 0));
    if (Object.keys(held).length) {
      const src = await settleAndLockRegion(tx, m.id, r.fromRegionId, at, m.speed, resourceMultOf(m));
      if (src.ownerPlayerId === r.playerId) {
        await applyCost(tx, src, held, -1);
        await recordSpend(tx, m, r.playerId, "build", held, -1);
      }
    }
    await tx.delete(tradeRoutes).where(eq(tradeRoutes.id, r.id));
  }
  await notify(tx, m.id, playerId, "system", `${ids.length} build${ids.length === 1 ? "" : "s"} and training at ${regionById(regionId)?.name ?? regionId} cancelled: the region is no longer yours`, { regionId });
  return ids.length;
}

/**
 * The safety net: builds and training still queued in a region their player no longer holds, in a running match, are
 * dropped as if the region had just been lost. Run by the worker every minute.
 */
export async function cancelJobsInLostRegions(db: Db): Promise<number> {
  const { matches } = await import("../db/schema.js");
  const stale = await db
    .selectDistinct({ matchId: jobs.matchId, playerId: jobs.playerId, regionId: jobs.regionId })
    .from(jobs)
    .innerJoin(matches, eq(matches.id, jobs.matchId))
    .leftJoin(matchRegions, and(eq(matchRegions.matchId, jobs.matchId), eq(matchRegions.regionId, jobs.regionId)))
    .where(and(eq(matches.status, "running"), inArray(jobs.kind, ["build", "train"]), isNull(jobs.completedAt), isNull(jobs.cancelledAt), isNotNull(jobs.regionId), sql`${matchRegions.ownerPlayerId} is distinct from ${jobs.playerId}`))
    .limit(200);
  let n = 0;
  for (const s of stale) {
    if (!s.playerId || !s.regionId) continue;
    const [m] = await db.select().from(matches).where(eq(matches.id, s.matchId)).limit(1);
    if (!m) continue;
    enterMap(mapOf(m));
    n += await db.transaction((tx) => dropLostJobs(tx, m, s.playerId!, s.regionId!, matchNow(m)));
  }
  return n;
}

/**
 * Knock a player out: their queues and routes stop and their armies disband where they stand. Their regions go to
 * the conqueror as newly taken land (loyalty starts low, so it wants garrisons), or turn neutral when nobody took the capital.
 */
export async function eliminatePlayer(tx: Tx, m: MatchRow, playerId: string, at: Date, reason: string, byPlayerId: string | null = null): Promise<void> {
  const { tradeRoutes, marketOrders, events } = await import("../db/schema.js");
  const [loser] = await tx.select({ name: players.name, capitalRegionId: players.capitalRegionId }).from(players).where(eq(players.id, playerId)).limit(1);
  const [winner] = byPlayerId ? await tx.select({ id: players.id, name: players.name, hidden: players.hidden }).from(players).where(eq(players.id, byPlayerId)).limit(1) : [];
  // The horde is nobody's realm: land it takes goes neutral like any other fall.
  const by = winner && !winner.hidden ? winner : null;
  // What the realm holds, noted before it changes hands, so the conqueror can be shown every region that came with the capital.
  // The capital itself has usually been handed over already by the battle, so it is fetched by id.
  const capitalId = loser?.capitalRegionId ?? null;
  const realmCols = { regionId: matchRegions.regionId, popWorkers: matchRegions.popWorkers, popSoldiers: matchRegions.popSoldiers, popOccupiers: matchRegions.popOccupiers, buildings: matchRegions.buildings };
  const realmRows = await tx.select(realmCols).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId), isNull(matchRegions.frozenAt)));
  if (capitalId && !realmRows.some((r) => r.regionId === capitalId)) {
    const [cap] = await tx.select(realmCols).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, capitalId))).limit(1);
    if (cap) realmRows.unshift(cap);
  }
  const realm = realmRows.map((r) => ({ ...r, isCapital: r.regionId === capitalId }));
  await tx.update(players).set({ eliminatedAt: at, capitalRegionId: null }).where(eq(players.id, playerId));
  await tx
    .update(matchRegions)
    .set(
      by
        ? { ownerPlayerId: by.id, isCapital: false, conquered: true, popOccupiers: 0, loyalty: balance.conquest.startingLoyalty, assignment: { ...balance.start.assignment } }
        : { ownerPlayerId: null, isCapital: false, conquered: false, popOccupiers: 0, loyalty: 1 },
    )
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId)));
  if (by) await clearMilitaryTargets(tx, m.id, by.id, realm.map((r) => r.regionId));
  await tx
    .update(jobs)
    .set({ cancelledAt: at })
    .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, playerId), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
  await tx.update(armies).set({ status: "done" }).where(and(eq(armies.matchId, m.id), eq(armies.playerId, playerId), inArray(armies.status, ["outbound", "returning", "fighting"])));
  await tx.delete(tradeRoutes).where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.playerId, playerId)));
  await tx.update(marketOrders).set({ status: "cancelled" }).where(and(eq(marketOrders.matchId, m.id), eq(marketOrders.playerId, playerId), eq(marketOrders.status, "open")));
  await tx.insert(events).values({ matchId: m.id, at, kind: "player.eliminated", payload: { playerId, reason, by: by?.id ?? null } });
  await notify(tx, m.id, playerId, "system", `${reason} You can watch the rest of the match and join the next one.`, {});
  if (by) {
    // The conqueror's own message carries the whole inheritance, region by region; the page pops it up.
    const regions = realm
      .map((r) => ({ id: r.regionId, name: regionById(r.regionId)?.name ?? r.regionId, people: Math.round(r.popWorkers + r.popSoldiers + r.popOccupiers), buildings: Object.values(r.buildings).reduce((a, b) => a + b, 0), capital: r.isCapital }))
      .sort((a, b) => Number(b.capital) - Number(a.capital) || b.people - a.people);
    await notify(tx, m.id, by.id, "battle", `You took ${loser?.name ?? "a tribe"}'s capital: ${regions.length} region${regions.length === 1 ? "" : "s"} and everyone in them are yours now`, { realmTaken: true, eliminated: playerId, loserName: loser?.name ?? null, regionId: capitalId ?? regions[0]?.id ?? null, regions });
    // Taking a capital is the biggest single prize in the game: a milestone worth balance.win.milestones.capital, once per capital that falls.
    const { awardMilestone } = await import("./endgame.js");
    await awardMilestone(tx, m, `capital_${playerId}`, by.id, at, `Took ${loser?.name ?? "a tribe"}'s capital`);
    // Everyone hears it: the fall of a realm is the news of the day.
    const line = `${loser?.name ?? "A tribe"} has been eliminated by ${by.name}: the capital fell and the whole realm is theirs now.`;
    const others = await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, m.id), eq(players.hidden, false), isNull(players.eliminatedAt), sql`${players.id} <> ${playerId}`));
    for (const o of others) await notify(tx, m.id, o.id, "battle", line, { eliminated: playerId, by: by.id, realm: true });
  }
}
