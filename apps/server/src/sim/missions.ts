import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { claimBounties } from "./objectives.js";
import { tribeBattleTalk } from "./tribeVoice.js";
import { balance, effectsOf, emptySpecial, storageCaps, regionById, resolveCombat, carryCapacity, travelSeconds, findRoute, armySpeed, type UnitCounts, HAULER_IDS, haulerCount, unitById, laneName, applyTechEffects, wallBonusAgainst, breachOf, buildingById, seededRng, availableTechs, scoutCatchChance, soldierCount, wallOf } from "@lastthaw/shared";
import { matchDayAt } from "./clock.js";
import { armies, battles, jobs, matchRegions, players, regionSightings, playerTechs, tradeRoutes, events } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { settleAndLockRegion, type MatchRegionRow, type Tx, setCapital, ownerTechEffects, waySetsFor, stockOf, resourceMultOf } from "./regions.js";
import { notify, type JobRow, type MatchRow } from "../worker/jobs.js";
import { areAllied, alliesOf } from "./alliances.js";
import { receiveMaterials } from "./commands.js";
import { causeForWar } from "./diplomacy.js";

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
export async function migrateCrowded(tx: Tx, m: MatchRow, now: Date, hours: number): Promise<number> {
  const share = Math.min(1, balance.economy.migrationPerHour * hours);
  if (share <= 0) return 0;
  const rows = await tx
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), isNotNull(matchRegions.ownerPlayerId), isNull(matchRegions.frozenAt), isNull(matchRegions.evacuatedAt)))
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
      const techRows = await tx.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
      const techs = new Set(techRows.map((t) => t.id));
      const { roads, rails, harbors } = await waySetsFor(tx, m.id, p.id, await alliesOf(tx, m.id, p.id));
      const route = findRoute(r.regionId, capital, techs.has(balance.travel.seaTech), roads, rails, harbors);
      if (route) {
        const capacity = carryCapacity(units, techs) + people * balance.travel.carryPerPerson;
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
        const seconds = travelSeconds(route, sumUnits(units) ? armySpeed(units) : (unitById.get("settler")?.speed ?? 4), m.speed);
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
  const techRows = await tx.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, playerId));
  const techs = new Set(techRows.map((t) => t.id));
  const { roads, rails, harbors } = await waySetsFor(tx, m.id, playerId, await alliesOf(tx, m.id, playerId));
  const rows = await tx
    .select({ regionId: matchRegions.regionId, units: matchRegions.units, frozenAt: matchRegions.frozenAt })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId)))
    .orderBy(matchRegions.regionId);
  let sent = 0;
  for (const r of rows) {
    if (r.regionId === targetRegionId || r.frozenAt || haulerCount(r.units) <= 0) continue;
    const route = findRoute(r.regionId, targetRegionId, techs.has(balance.travel.seaTech), roads, rails, harbors);
    if (!route) continue;
    const row = await settleAndLockRegion(tx, m.id, r.regionId, at, m.speed, resourceMultOf(m));
    const going: UnitCounts = {};
    for (const id of HAULER_IDS) if ((row.units[id] ?? 0) > 0 && !unitById.get(id)?.naval) going[id] = row.units[id]!;
    const have = sumUnits(going);
    if (have <= 0) continue;
    const seconds = travelSeconds(route, armySpeed(going), m.speed);
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
  const occupied = target.ownerPlayerId || target.popWorkers + target.popSoldiers + target.popOccupiers >= 1 || Object.values(target.units).some((n) => n > 0);
  if (occupied) {
    const by = target.ownerPlayerId ? await playerName(tx, target.ownerPlayerId) : "a neutral tribe";
    await notify(tx, m.id, army.playerId, "system", `${name} was claimed by ${by} before your settlers arrived; they are coming back`, { regionId: army.targetRegionId });
    return sendHome(tx, m, army, at, army.units, army.cargo, `${name} was claimed first by ${by}`);
  }
  const settlers = army.units.settler ?? 0;
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

/** Send the army back where it came from, carrying whatever is in cargo. */
async function sendHome(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, units: UnitCounts, cargo: Record<string, number>, note: string | null = null): Promise<void> {
  if (sumUnits(units) === 0 && Object.values(cargo).every((v) => !v)) {
    await tx.update(armies).set({ status: "done", units, cargo }).where(eq(armies.id, army.id));
    return;
  }
  const route = findRoute(army.targetRegionId, army.originRegionId, true) ?? { path: [army.targetRegionId, army.originRegionId], cost: 1000, usesSea: false };
  const seconds = travelSeconds(route, sumUnits(units) ? armySpeed(units) : 5, m.speed);
  const returnsAt = new Date(at.getTime() + seconds * 1000);
  await tx.update(armies).set({ status: "returning", units, cargo, returnsAt, note }).where(eq(armies.id, army.id));
  await tx.insert(jobs).values({ matchId: m.id, playerId: army.playerId, regionId: army.originRegionId, kind: "mission", refId: army.id, startsAt: at, endsAt: returnsAt });
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

async function deliverCargo(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
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
  // Escorts walk back empty.
  await sendHome(tx, m, army, at, army.units, {});
  const pid = army.playerId;
  after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id }));
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
    const chance = scoutCatchChance({ held: !!target.ownerPlayerId, soldiers: soldierCount(target.units), watchtower, wall: wallOf(target.buildings) !== null });
    if (chance > 0) {
      const rng = seededRng(`${m.seed}:scout:${army.id}`);
      for (let i = 0; i < sent; i++) if (rng() < chance) caught += 1;
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

async function battle(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const region = regionById(army.targetRegionId)!;
  const defenderId = target.ownerPlayerId;

  // Attacking a friend (alliance formed mid-flight) is called off.
  if (defenderId && (defenderId === army.playerId || (await areAllied(tx, m.id, army.playerId, defenderId)))) {
    await notify(tx, m.id, army.playerId, "battle", `Attack on ${region.name} called off: the region is friendly`, { regionId: region.id });
    return sendHome(tx, m, army, at, army.units, army.cargo, "called off: the region is now friendly");
  }

  const effects = effectsOf(target.buildings);
  const militia = Math.floor(((target.popWorkers + target.popOccupiers) / 10) * balance.combat.militiaPerTenPeople);
  const defenderUnits: UnitCounts = militia > 0 ? addUnits(target.units, { militia }) : { ...target.units };
  const attackerTech = await ownerTechEffects(tx, army.playerId);
  const defenderTech = await ownerTechEffects(tx, target.ownerPlayerId);
  const seed = `${m.seed}:${army.id}:${at.getTime()}`;
  // Settlers travelling with a conquest wait behind the lines; they occupy if the battle is won.
  const { settler: settlersAlong = 0, ...fighting } = army.units;
  // Walls are near-impregnable to men alone; siege engines bring the wall bonus down. Techs and terrain always count.
  const wallFull = Object.keys(balance.combat.wallBreach).reduce((a, id) => a + (buildingById.get(id)?.effect.defense ?? 0) * (target.buildings[id] ?? 0), 0);
  const wallBonus = wallBonusAgainst(target.buildings, fighting);
  const bonus = effects.defense - wallFull + wallBonus + defenderTech.defense + (balance.combat.terrainDefense[region.terrain] ?? 0);
  const result = resolveCombat({ units: fighting, bonus: attackerTech.attack }, { units: defenderUnits, bonus }, seed);

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
  const attackerName = await playerName(tx, army.playerId);
  const defenderName = defenderId ? await playerName(tx, defenderId) : "Neutral tribes";

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
      // Pending jobs of the old owner in this region are lost.
      await tx
        .update(jobs)
        .set({ cancelledAt: at })
        .where(and(eq(jobs.matchId, m.id), eq(jobs.regionId, army.targetRegionId), inArray(jobs.kind, ["build", "train"]), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
    }
  }

  await tx.update(matchRegions).set(set).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, army.targetRegionId)));

  const report = {
    walls: { bonus: Math.round(wallBonus * 100) / 100, full: Math.round(wallFull * 100) / 100, siege: breachOf(fighting) },
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
  await tx.insert(battles).values({ matchId: m.id, regionId: army.targetRegionId, resolvedAt: at, seed, attackerPlayerId: army.playerId, defenderPlayerId: defenderId, report });
  if (result.attackerWon) await claimBounties(tx, m, army.playerId, army.targetRegionId, defenderId, at);
  // The tribes talk about it in the match chat when it mattered.
  const lossesAll = Object.values(result.attackerLosses).reduce((a, b) => a + b, 0) + Object.values(result.defenderLosses).reduce((a, b) => a + b, 0);
  await tribeBattleTalk(tx, m, { attackerId: army.playerId, defenderId, attackerName, defenderName, region: region.name, attackerWon: result.attackerWon, conquered, losses: lossesAll, seed }, at, publisher, after);
  const verb = army.mission === "raid" ? "Raid on" : "Attack on";
  await notify(tx, m.id, army.playerId, "battle", `${verb} ${region.name}: ${result.attackerWon ? "victory" : "defeat"}${conquered ? ", region conquered" : ""}`, { regionId: region.id, report });
  if (defenderId) await notify(tx, m.id, defenderId, "battle", `${attackerName} ${army.mission === "raid" ? "raided" : "attacked"} ${region.name}: ${result.attackerWon ? "they won" : "we held"}${conquered ? ", region lost" : ""}`, { regionId: region.id, report });
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
 * Knock a player out: their queues and routes stop and their armies disband where they stand. Their regions go to
 * the conqueror as newly taken land (loyalty starts low, so it wants garrisons), or turn neutral when nobody took the capital.
 */
export async function eliminatePlayer(tx: Tx, m: MatchRow, playerId: string, at: Date, reason: string, byPlayerId: string | null = null): Promise<void> {
  const { tradeRoutes, marketOrders, events } = await import("../db/schema.js");
  const [loser] = await tx.select({ name: players.name }).from(players).where(eq(players.id, playerId)).limit(1);
  const [winner] = byPlayerId ? await tx.select({ id: players.id, name: players.name, hidden: players.hidden }).from(players).where(eq(players.id, byPlayerId)).limit(1) : [];
  // The horde is nobody's realm: land it takes goes neutral like any other fall.
  const by = winner && !winner.hidden ? winner : null;
  await tx.update(players).set({ eliminatedAt: at, capitalRegionId: null }).where(eq(players.id, playerId));
  await tx
    .update(matchRegions)
    .set(
      by
        ? { ownerPlayerId: by.id, isCapital: false, conquered: true, popOccupiers: 0, loyalty: balance.conquest.startingLoyalty, assignment: { ...balance.start.assignment } }
        : { ownerPlayerId: null, isCapital: false, conquered: false, popOccupiers: 0, loyalty: 1 },
    )
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId)));
  await tx
    .update(jobs)
    .set({ cancelledAt: at })
    .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, playerId), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
  await tx.update(armies).set({ status: "done" }).where(and(eq(armies.matchId, m.id), eq(armies.playerId, playerId), inArray(armies.status, ["outbound", "returning"])));
  await tx.delete(tradeRoutes).where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.playerId, playerId)));
  await tx.update(marketOrders).set({ status: "cancelled" }).where(and(eq(marketOrders.matchId, m.id), eq(marketOrders.playerId, playerId), eq(marketOrders.status, "open")));
  await tx.insert(events).values({ matchId: m.id, at, kind: "player.eliminated", payload: { playerId, reason, by: by?.id ?? null } });
  await notify(tx, m.id, playerId, "system", `${reason} You can watch the rest of the match and join the next one.`, {});
  if (by) {
    // Everyone hears it: the fall of a realm is the news of the day.
    const line = `${loser?.name ?? "A tribe"} has been eliminated by ${by.name}: the capital fell and the whole realm is theirs now.`;
    const others = await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, m.id), eq(players.hidden, false), isNull(players.eliminatedAt), sql`${players.id} <> ${playerId}`));
    for (const o of others) await notify(tx, m.id, o.id, "battle", line, { eliminated: playerId, by: by.id, realm: true });
  }
}
