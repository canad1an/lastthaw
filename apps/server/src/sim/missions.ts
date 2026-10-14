import { and, eq, inArray, isNull } from "drizzle-orm";
import { balance, effectsOf, emptySpecial, regionById, resolveCombat, carryCapacity, travelSeconds, findRoute, armySpeed, type UnitCounts } from "@lastthaw/shared";
import { armies, battles, jobs, matchRegions, players, regionSightings } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { settleAndLockRegion, type MatchRegionRow, type Tx } from "./regions.js";
import { notify, type JobRow, type MatchRow } from "../worker/jobs.js";
import { areAllied } from "./alliances.js";

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
  }
}

/** Send the army back where it came from, carrying whatever is in cargo. */
async function sendHome(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, units: UnitCounts, cargo: Record<string, number>): Promise<void> {
  if (sumUnits(units) === 0 && Object.values(cargo).every((v) => !v)) {
    await tx.update(armies).set({ status: "done", units, cargo }).where(eq(armies.id, army.id));
    return;
  }
  const route = findRoute(army.targetRegionId, army.originRegionId, true) ?? { path: [army.targetRegionId, army.originRegionId], cost: 1000, usesSea: false };
  const seconds = travelSeconds(route, sumUnits(units) ? armySpeed(units) : 5, m.speed);
  const returnsAt = new Date(at.getTime() + seconds * 1000);
  await tx.update(armies).set({ status: "returning", units, cargo, returnsAt }).where(eq(armies.id, army.id));
  await tx.insert(jobs).values({ matchId: m.id, playerId: army.playerId, regionId: army.originRegionId, kind: "mission", refId: army.id, startsAt: at, endsAt: returnsAt });
}

async function comeHome(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  let home = await lockRegion(tx, m, army.originRegionId, at);
  if (home.ownerPlayerId !== army.playerId) {
    const [p] = await tx.select().from(players).where(eq(players.id, army.playerId)).limit(1);
    if (p?.capitalRegionId && p.capitalRegionId !== army.originRegionId) home = await lockRegion(tx, m, p.capitalRegionId, at);
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
  const cap = balance.economy.baseStorage;
  const set: Partial<MatchRegionRow> = {
    units: addUnits(row.units, units),
    popSoldiers: row.popSoldiers + sumUnits(units),
    popWorkers: row.popWorkers + (cargo.people ?? 0),
  };
  for (const r of BASE) set[r] = Math.min(cap[r] * effects.storage, row[r] + (cargo[r] ?? 0));
  for (const s of SPECIAL) special[s] = Math.min(balance.economy.specialStorage, (special[s] ?? 0) + (cargo[s] ?? 0));
  set.special = special;
  await tx.update(matchRegions).set(set).where(and(eq(matchRegions.matchId, row.matchId), eq(matchRegions.regionId, row.regionId)));
}

async function deliverUnits(tx: Tx, m: MatchRow, army: ArmyRow, at: Date, publisher: Publisher, after: After): Promise<void> {
  const target = await lockRegion(tx, m, army.targetRegionId, at);
  const friendly = target.ownerPlayerId === army.playerId || (target.ownerPlayerId ? await areAllied(tx, m.id, army.playerId, target.ownerPlayerId) : false);
  if (!friendly) {
    await notify(tx, m.id, army.playerId, "system", `${regionById(army.targetRegionId)?.name} is no longer friendly; the army is coming back`, {});
    return sendHome(tx, m, army, at, army.units, army.cargo);
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
    return sendHome(tx, m, army, at, army.units, army.cargo);
  }
  const { people: _people, ...goods } = army.cargo;
  await depositInto(tx, target, {}, army.cargo);
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
    return sendHome(tx, m, army, at, army.units, army.cargo);
  }

  const effects = effectsOf(target.buildings);
  const militia = Math.floor(((target.popWorkers + target.popOccupiers) / 10) * balance.combat.militiaPerTenPeople);
  const defenderUnits: UnitCounts = militia > 0 ? addUnits(target.units, { militia }) : { ...target.units };
  const bonus = effects.defense + (balance.combat.terrainDefense[region.terrain] ?? 0);
  const seed = `${m.seed}:${army.id}:${at.getTime()}`;
  const result = resolveCombat({ units: army.units, bonus: 0 }, { units: defenderUnits, bonus }, seed);

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
    const people = army.cargo.people ?? 0;
    if (people >= balance.conquest.occupiersRequired) {
      conquered = true;
      Object.assign(set, {
        ownerPlayerId: army.playerId,
        units: survivors,
        popSoldiers: sumUnits(survivors),
        popOccupiers: people,
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
    await sendHome(tx, m, army, at, survivors, { ...loot, people: army.cargo.people ?? 0 });
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
    await tx.update(players).set({ capitalRegionId: next.regionId }).where(eq(players.id, playerId));
    await notify(tx, m.id, playerId, "system", `Your capital has moved to ${regionById(next.regionId)?.name}`, { regionId: next.regionId });
  }
}
