import { and, eq, inArray, isNull } from "drizzle-orm";
import { balance, effectsOf, emptySpecial, storageCaps, regionById, resolveCombat, carryCapacity, travelSeconds, findRoute, armySpeed, type UnitCounts, HAULER_IDS, haulerCount } from "@lastthaw/shared";
import { armies, battles, jobs, matchRegions, players, regionSightings, playerTechs } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { settleAndLockRegion, type MatchRegionRow, type Tx, setCapital, ownerTechEffects, waySetsFor } from "./regions.js";
import { notify, type JobRow, type MatchRow } from "../worker/jobs.js";
import { areAllied, alliesOf } from "./alliances.js";
import { startWaitingBuilds } from "./commands.js";

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
  return settleAndLockRegion(tx, m.id, regionId, at, m.speed);
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
  }
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

/** Every stationed caravan outside `targetRegionId` walks there. Returns how many were sent. */
async function gatherCaravans(tx: Tx, m: MatchRow, playerId: string, targetRegionId: string, at: Date): Promise<number> {
  const [p] = await tx.select().from(players).where(eq(players.id, playerId)).limit(1);
  if (!p) return 0;
  const techRows = await tx.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, playerId));
  const techs = new Set(techRows.map((t) => t.id));
  const { roads, rails } = await waySetsFor(tx, m.id, playerId, await alliesOf(tx, m.id, playerId));
  const rows = await tx
    .select({ regionId: matchRegions.regionId, units: matchRegions.units, frozenAt: matchRegions.frozenAt })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId)))
    .orderBy(matchRegions.regionId);
  let sent = 0;
  for (const r of rows) {
    if (r.regionId === targetRegionId || r.frozenAt || haulerCount(r.units) <= 0) continue;
    const route = findRoute(r.regionId, targetRegionId, techs.has(balance.travel.seaTech), roads, rails);
    if (!route) continue;
    const row = await settleAndLockRegion(tx, m.id, r.regionId, at, m.speed);
    const going: UnitCounts = {};
    for (const id of HAULER_IDS) if ((row.units[id] ?? 0) > 0) going[id] = row.units[id]!;
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
    await notify(tx, m.id, army.playerId, "system", `${regionById(army.targetRegionId)?.name} is no longer friendly; the army is coming back`, {});
    return sendHome(tx, m, army, at, army.units, army.cargo, `${regionById(army.targetRegionId)?.name} is no longer friendly`);
  }
  await depositInto(tx, target, army.units, army.cargo);
  await tx.update(armies).set({ status: "done" }).where(eq(armies.id, army.id));
  await notify(tx, m.id, army.playerId, "system", `Troops arrived in ${regionById(army.targetRegionId)?.name}`, { regionId: army.targetRegionId, units: army.units });
  if (target.ownerPlayerId && target.ownerPlayerId !== army.playerId) {
    await notify(tx, m.id, target.ownerPlayerId, "alliance", `${await playerName(tx, army.playerId)} reinforced ${regionById(army.targetRegionId)?.name}`, { regionId: army.targetRegionId });
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
    await notify(tx, m.id, army.playerId, "trade", `${regionById(army.targetRegionId)?.name} is no longer friendly; the goods are coming back`, {});
    return sendHome(tx, m, army, at, army.units, army.cargo, `${regionById(army.targetRegionId)?.name} is no longer friendly`);
  }
  const { people: _people, ...goods } = army.cargo;
  await depositInto(tx, target, {}, army.cargo);
  if (target.ownerPlayerId === army.playerId) {
    const started = await startWaitingBuilds(tx, m, army.targetRegionId, at);
    if (started) await notify(tx, m.id, army.playerId, "build", `Materials arrived in ${regionById(army.targetRegionId)?.name}: ${started} build${started === 1 ? "" : "s"} started`, { regionId: army.targetRegionId });
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

async function scout(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const ownerName = target.ownerPlayerId ? await playerName(tx, target.ownerPlayerId) : null;
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
  const name = regionById(army.targetRegionId)?.name ?? army.targetRegionId;
  await notify(tx, m.id, army.playerId, "scout", `Scout report: ${name}`, { regionId: army.targetRegionId, ...snapshot });
  if (target.ownerPlayerId && target.ownerPlayerId !== army.playerId) {
    await notify(tx, m.id, target.ownerPlayerId, "scout", `Scouts from ${await playerName(tx, army.playerId)} were seen in ${name}`, { regionId: army.targetRegionId });
  }
  await sendHome(tx, m, army, at, army.units, {});
  const pid = army.playerId;
  after(() => publisher.toPlayer(m.id, pid, "army.arrived", { armyId: army.id }));
}

async function battle(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const region = regionById(army.targetRegionId)!;
  const defenderId = target.ownerPlayerId;

  // Attacking a friend (alliance formed mid-flight) is called off.
  if (defenderId && (defenderId === army.playerId || (await areAllied(tx, m.id, army.playerId, defenderId)))) {
    await notify(tx, m.id, army.playerId, "battle", `Attack on ${region.name} called off: the region is friendly`, {});
    return sendHome(tx, m, army, at, army.units, army.cargo, "called off: the region is now friendly");
  }

  const effects = effectsOf(target.buildings);
  const militia = Math.floor(((target.popWorkers + target.popOccupiers) / 10) * balance.combat.militiaPerTenPeople);
  const defenderUnits: UnitCounts = militia > 0 ? addUnits(target.units, { militia }) : { ...target.units };
  const attackerTech = await ownerTechEffects(tx, army.playerId);
  const defenderTech = await ownerTechEffects(tx, target.ownerPlayerId);
  const bonus = effects.defense + defenderTech.defense + (balance.combat.terrainDefense[region.terrain] ?? 0);
  const seed = `${m.seed}:${army.id}:${at.getTime()}`;
  // Settlers travelling with a conquest wait behind the lines; they occupy if the battle is won.
  const { settler: settlersAlong = 0, ...fighting } = army.units;
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
    for (const r of BASE) unprotected[r] = Math.max(0, target[r] - effects.protect) * balance.combat.raidShare;
    const special: Record<string, number> = { ...emptySpecial(), ...(target.special as Record<string, number>) };
    for (const s of SPECIAL) unprotected[s] = (special[s] ?? 0) * balance.combat.raidShare;
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
  const verb = army.mission === "raid" ? "Raid on" : "Attack on";
  await notify(tx, m.id, army.playerId, "battle", `${verb} ${region.name}: ${result.attackerWon ? "victory" : "defeat"}${conquered ? ", region conquered" : ""}`, { report });
  if (defenderId) await notify(tx, m.id, defenderId, "battle", `${attackerName} ${army.mission === "raid" ? "raided" : "attacked"} ${region.name}: ${result.attackerWon ? "they won" : "we held"}${conquered ? ", region lost" : ""}`, { report });

  if (conquered) {
    await tx.update(armies).set({ status: "done", units: survivors }).where(eq(armies.id, army.id));
    if (defenderId) await handleRegionLost(tx, m, defenderId, army.targetRegionId, at);
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

/** A player lost a region: move the capital if needed, eliminate if nothing is left. */
export async function handleRegionLost(tx: Tx, m: MatchRow, playerId: string, regionId: string, at: Date): Promise<void> {
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
    const next = [...remaining].sort((a, b) => b.pop - a.pop)[0]!;
    await setCapital(tx, m.id, playerId, next.regionId);
    await notify(tx, m.id, playerId, "system", `Your capital has moved to ${regionById(next.regionId)?.name}`, { regionId: next.regionId });
  }
}
