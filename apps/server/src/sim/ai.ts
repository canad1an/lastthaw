import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  availableBuildings,
  availableTechs,
  buildingBlockedBy,
  availableUnits,
  balance,
  buildingById,
  buildingCost,
  dayCostMultiplier,
  effectsOf,
  freezeDayForLatitude,
  distanceKm,
  regionById,
  seededRng,
  techById,
  techCost,
  normalizeAssignment,
  type Cost,
} from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, jobs, marketOrders, matchRegions, playerTechs, players } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { applyCost, projectRegion, settleAndLockRegion, stockOf, type MatchRegionRow } from "./regions.js";
import { queueBuild, queueResearch, queueTrain, sendArmy, type CommandContext, type PlayerRow } from "./commands.js";
import { areAllied } from "./alliances.js";
import type { MatchRow } from "../worker/jobs.js";

export type Difficulty = "easy" | "medium" | "hard";
export type Temperament = "peaceful" | "balanced" | "raider";

const BUILD_ORDER = ["huts", "hunting_grounds", "lumber_camp", "storehouse", "quarry", "farm", "palisade", "granary", "mine", "stables", "walls", "barracks", "roads", "temple", "forge", "market", "aqueduct", "fort", "library", "harbor", "windmill", "castle", "guild_hall", "university", "cathedral"];
const RESEARCH_ORDER = ["fire_making", "flint_tools", "agriculture", "animal_husbandry", "bronze_working", "mining", "writing", "the_wheel", "iron_working", "masonry", "siegecraft", "drill", "engineering", "shipbuilding", "chivalry", "siege_engines", "scholasticism"];

/** What each difficulty is allowed to do. Harder tiers never cheat; they just decide better and more often. */
const TIER = {
  easy: { cadence: { min: 90, max: 180 }, buildCap: (age: number) => 6 + age * 2, aggression: 0.5, reactsToThreat: false, iceRetreatDays: 1, adaptiveEconomy: false, adaptiveResearch: false, conquersHumans: false, scoresTargets: false, hoards: true, reach: 1, settles: false },
  medium: { cadence: { min: 40, max: 90 }, buildCap: (age: number) => 10 + age * 3, aggression: 1, reactsToThreat: true, iceRetreatDays: 2, adaptiveEconomy: false, adaptiveResearch: false, conquersHumans: true, scoresTargets: false, hoards: false, reach: 2, settles: true },
  hard: { cadence: { min: 20, max: 45 }, buildCap: (age: number) => 14 + age * 4, aggression: 1.4, reactsToThreat: true, iceRetreatDays: 4, adaptiveEconomy: true, adaptiveResearch: true, conquersHumans: true, scoresTargets: true, hoards: false, reach: 3, settles: true },
} as const;

export function parseProfile(profile: string | null): { difficulty: Difficulty; temperament: Temperament } {
  const [a, b] = (profile ?? "medium:balanced").split(":");
  const difficulty = (["easy", "medium", "hard"].includes(a ?? "") ? a : "medium") as Difficulty;
  const temperament = (["peaceful", "balanced", "raider"].includes(b ?? "") ? b : "balanced") as Temperament;
  return { difficulty, temperament };
}

/** Pick a profile for a new AI tribe from the match's difficulty setting. */
export function randomProfile(rng: () => number, setting: string | undefined): string {
  const mix = balance.ai.difficultyMix;
  let difficulty: Difficulty;
  if (setting === "easy" || setting === "medium" || setting === "hard") difficulty = setting;
  else {
    const r = rng();
    difficulty = r < mix.easy ? "easy" : r < mix.easy + mix.medium ? "medium" : "hard";
  }
  const t = rng();
  const temperament: Temperament = t < 0.3 ? "peaceful" : t < 0.75 ? "balanced" : "raider";
  return `${difficulty}:${temperament}`;
}

/**
 * One round of decisions for an AI tribe. Uses the same commands as humans.
 * Each action is independent: a failure (cannot afford, queue full) is ignored.
 */
export async function runAiPlayer(db: Db, m: MatchRow, p: PlayerRow, now: Date, _publisher: Publisher): Promise<void> {
  const { difficulty, temperament } = parseProfile(p.aiProfile);
  const tier = TIER[difficulty];
  const rng = seededRng(`${m.seed}:${p.id}:${now.getTime()}`);
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
  const techs = new Set(techRows.map((t) => t.id));
  const ctx: CommandContext = { db, m, p, techs };
  const attempt = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };

  const owned = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id)));
  if (owned.length === 0) return;
  const pendingJobs = await db
    .select({ regionId: jobs.regionId, kind: jobs.kind })
    .from(jobs)
    .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, p.id), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
  const researching = pendingJobs.some((j) => j.kind === "research");
  const queueLen = (regionId: string) => pendingJobs.filter((j) => j.regionId === regionId).length;
  const ownedIds = owned.map((r) => r.regionId);
  const matchDay = ((now.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed;

  // Threats: hostile armies heading for my regions (medium and hard react).
  const threatened = new Set<string>();
  if (tier.reactsToThreat) {
    const incoming = await db
      .select({ target: armies.targetRegionId })
      .from(armies)
      .where(and(eq(armies.matchId, m.id), eq(armies.status, "outbound"), inArray(armies.targetRegionId, ownedIds), inArray(armies.mission, ["raid", "conquer"]), sql`${armies.playerId} <> ${p.id}`));
    for (const i of incoming) threatened.add(i.target);
  }

  // Ice: regions that freeze soon get evacuated to the safest owned region.
  const pendingSettle = await db
    .select({ target: armies.targetRegionId })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "settle"), eq(armies.status, "outbound")));
  const settlingTo = new Set(pendingSettle.map((a) => a.target));
  if (tier.iceRetreatDays > 0) await retreatFromIce(ctx, owned, matchDay, tier.iceRetreatDays, attempt, settlingTo, queueLen);

  for (const row of owned) {
    if (row.frozenAt) continue;
    const region = regionById(row.regionId)!;
    const { economy, rates } = projectRegion(row, now, m.speed);
    const pop = economy.popWorkers + economy.popSoldiers + economy.popOccupiers;
    const underThreat = threatened.has(row.regionId);

    // Buildings: walls first when threatened, otherwise the priority list.
    let slots = balance.queue.slotsPerRegion - queueLen(row.regionId);
    const avail = new Map(availableBuildings(p.age, techs).map((b) => [b.id, b]));
    const order = [...BUILD_ORDER];
    if (underThreat) order.unshift("walls", "palisade");
    if (pop / economy.capacity > 0.75) order.unshift("huts");
    if (economy.food > economy.storage.food * 0.85 || economy.wood > economy.storage.wood * 0.85) order.unshift("storehouse");
    let wanted: Cost | null = null;
    for (const id of order) {
      const def = avail.get(id);
      if (!def) continue;
      if (buildingBlockedBy(def, region)) continue;
      const level = row.buildings[id] ?? 0;
      if (level >= Math.min(def.maxLevel, tier.buildCap(p.age))) continue;
      const cost = buildingCost(def, level + 1, matchDay);
      if (!wanted) wanted = cost;
      if (slots <= 0) break;
      if (tier.hoards && !comfortablyAffordable(economy, cost)) continue;
      if (await attempt(() => queueBuild(ctx, row.regionId, id))) slots -= 1;
      else if (rng() < 0.5) break;
    }

    // Economy: hard tribes steer workers toward what the next building needs; others use a fixed split.
    const want = tier.adaptiveEconomy && wanted ? steerToward(economy, rates, wanted) : rates.food < 0 || economy.food < 60 ? { food: 0.7, wood: 0.2, stone: 0.1 } : { food: 0.35, wood: 0.4, stone: 0.25 };
    const cur = normalizeAssignment(row.assignment);
    if (Math.abs(cur.food - want.food) > 0.05 || Math.abs(cur.stone - want.stone) > 0.05 || Math.abs(cur.wood - want.wood) > 0.05) {
      await attempt(() =>
        db.transaction(async (tx) => {
          await settleAndLockRegion(tx, m.id, row.regionId, now, m.speed);
          await tx.update(matchRegions).set({ assignment: want }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, row.regionId)));
        }),
      );
    }

    // Soldiers: keep a share under arms; double it while threatened.
    const share = (balance.ai.soldierShare[temperament] ?? 0.2) * (underThreat ? 2 : 1);
    if (queueLen(row.regionId) < balance.queue.slotsPerRegion && economy.popSoldiers < pop * share && economy.popWorkers > 8) {
      const units = availableUnits(p.age, techs).filter((u) => !u.needsResource || region.resources.includes(u.needsResource));
      const best = [...units].sort((a, b) => b.attack + b.defense - (a.attack + a.defense))[0];
      const qty = Math.max(1, Math.min(underThreat ? 20 : 10, Math.floor(economy.popWorkers * (underThreat ? 0.3 : 0.15))));
      if (best) await attempt(() => queueTrain(ctx, row.regionId, best.id, qty));
    }
  }

  // Reinforce a threatened region from the strongest other region (medium and hard).
  if (threatened.size && owned.length > 1) {
    for (const target of threatened) {
      const donor = owned
        .filter((r) => r.regionId !== target && !threatened.has(r.regionId))
        .sort((a, b) => b.popSoldiers - a.popSoldiers)[0];
      if (!donor || donor.popSoldiers < 4) continue;
      const send: Record<string, number> = {};
      for (const [id, n] of Object.entries(donor.units)) send[id] = Math.floor(n * 0.6);
      await attempt(() => sendArmy(ctx, donor.regionId, { mission: "move", targetRegionId: target, units: send, people: 0, cargo: {} }));
    }
  }

  // Research: hard tribes jump on age advances; easy tribes only research with a comfortable surplus.
  if (!researching) {
    const avail = availableTechs(p.age, techs);
    let next = tier.adaptiveResearch ? avail.find((t) => t.advancesTo !== undefined)?.id : undefined;
    if (!next) {
      const ids = new Set(avail.map((t) => t.id));
      next = RESEARCH_ORDER.find((t) => ids.has(t));
    }
    if (next) {
      const def = techById.get(next)!;
      const capital = owned.find((r) => r.regionId === p.capitalRegionId) ?? owned[0]!;
      const { economy } = projectRegion(capital, now, m.speed);
      if (!tier.hoards || comfortablyAffordable(economy, techCost(def, matchDay))) await attempt(() => queueResearch(ctx, next!));
    }
  }

  // Expansion: a crowded region trains settlers and claims the nearest free land. One colony at a time.
  if (tier.settles && settlingTo.size === 0) {
    const crowded = [...owned].filter((r) => !r.frozenAt && r.popWorkers >= balance.ai.settleAbove).sort((a, b) => b.popWorkers - a.popWorkers);
    for (const row of crowded) {
      const settlers = row.units.settler ?? 0;
      const need = balance.settle.settlersRequired;
      if (settlers >= need) {
        const free = await freeFrontier(db, m.id, ownedIds, (id) => (freezeDayForLatitude(Math.abs(regionById(id)!.lat)) ?? 999) - matchDay > 6);
        const target = free.sort((a, b) => distanceKm(row.regionId, a) - distanceKm(row.regionId, b))[0];
        if (target && (await attempt(() => sendArmy(ctx, row.regionId, { mission: "settle", targetRegionId: target, units: { settler: need }, people: 0, cargo: {} })))) break;
      } else if (!pendingJobs.some((j) => j.regionId === row.regionId && j.kind === "train") && queueLen(row.regionId) < balance.queue.slotsPerRegion) {
        if (await attempt(() => queueTrain(ctx, row.regionId, "settler", need))) break;
      }
    }
  }

  // Ore for sale: a tribe sitting on more ore than it needs lists half of it for wood.
  await sellOre(ctx, owned, now);

  // Aggression: raid or conquer a weak neighbour. Hard tribes get hungrier when they fall behind.
  const standings = await db.select({ owner: matchRegions.ownerPlayerId, n: sql<number>`count(*)::int` }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), sql`${matchRegions.ownerPlayerId} is not null`)).groupBy(matchRegions.ownerPlayerId);
  const leader = Math.max(...standings.map((s) => s.n), 1);
  const behind = tier.scoresTargets && leader - owned.length > 2 ? 1.5 : 1;
  const raidChance = (balance.ai.raidChance[temperament] ?? 0.15) * tier.aggression * behind;
  const conquerChance = (balance.ai.conquerChance[temperament] ?? 0.2) * tier.aggression * behind;
  const inFlight = await db
    .select({ id: armies.id })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), inArray(armies.status, ["outbound", "returning"])));
  const maxInFlight = difficulty === "hard" ? 3 : 2;
  if (inFlight.length < maxInFlight && threatened.size === 0) {
    const roll = rng();
    if (roll < raidChance + conquerChance) {
      const wantConquer = roll >= raidChance;
      const strong = [...owned].sort((a, b) => b.popSoldiers - a.popSoldiers)[0]!;
      const soldiers = Object.values(strong.units).reduce((a, b) => a + b, 0);
      if (soldiers >= 6) {
        const reach = tier.reach + (matchDay >= 10 ? 1 : 0);
        let ring = new Set<string>([strong.regionId]);
        const seen = new Set<string>(ring);
        for (let i = 0; i < reach; i++) {
          const next = new Set<string>();
          for (const id of ring) for (const n of regionById(id)!.neighbors) if (!seen.has(n)) { seen.add(n); next.add(n); }
          ring = next;
        }
        const candidatesIds = [...seen].filter((id) => !ownedIds.includes(id));
        const rows = await db
          .select()
          .from(matchRegions)
          .where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, candidatesIds)));
        const byId = new Map(rows.map((r) => [r.regionId, r]));
        const ownerIds = [...new Set(rows.map((r) => r.ownerPlayerId).filter((x): x is string => !!x))];
        const owners = ownerIds.length ? await db.select().from(players).where(inArray(players.id, ownerIds)) : [];
        const ownerById = new Map(owners.map((o) => [o.id, o]));
        const candidates: Array<{ id: string; defenders: number; score: number }> = [];
        for (const n of candidatesIds) {
          const r = byId.get(n);
          const owner = r?.ownerPlayerId ?? null;
          if (owner === p.id) continue;
          if (owner && (await areAllied(db, m.id, p.id, owner))) continue;
          const o = owner ? ownerById.get(owner) : null;
          if (o?.protectionUntil && o.protectionUntil.getTime() > now.getTime()) continue;
          if (wantConquer && owner && !o?.isAi && !tier.conquersHumans) continue;
          const effects = r ? effectsOf(r.buildings) : null;
          const defenders = r ? Object.values(r.units).reduce((a, b) => a + b, 0) * (1 + (effects?.defense ?? 0)) + (r.popWorkers / 10) * balance.combat.militiaPerTenPeople : 0;
          if (defenders > soldiers * balance.ai.maxTargetStrengthRatio) continue;
          const loot = r ? Math.max(0, r.food + r.wood + r.stone - 3 * (effects?.protect ?? 0)) : 0;
          const dist = distanceKm(strong.regionId, n);
          const score = tier.scoresTargets ? (wantConquer ? regionById(n)!.value * 1000 : loot) / (defenders + 1) / (1 + dist / 1000) : -defenders;
          candidates.push({ id: n, defenders, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        const target = candidates[0];
        if (target) {
          const send: Record<string, number> = {};
          for (const [id, n] of Object.entries(strong.units)) send[id] = Math.floor(n * (difficulty === "hard" ? 0.8 : 0.7));
          const people = wantConquer ? balance.conquest.occupiersRequired + 2 : 0;
          if (!wantConquer || strong.popWorkers > people + 10) {
            await attempt(() => sendArmy(ctx, strong.regionId, { mission: wantConquer ? "conquer" : "raid", targetRegionId: target.id, units: send, people, cargo: {} }));
          }
        }
      }
    }
  }

  const { min, max } = tier.cadence;
  const minutes = min + rng() * (max - min);
  await db.update(players).set({ nextAiAt: new Date(now.getTime() + (minutes * 60 * 1000) / m.speed) }).where(eq(players.id, p.id));
}

function comfortablyAffordable(e: { food: number; wood: number; stone: number; special: Record<string, number> }, cost: Cost): boolean {
  const stock: Record<string, number> = { food: e.food, wood: e.wood, stone: e.stone, ...e.special };
  return Object.entries(cost).every(([k, v]) => (stock[k] ?? 0) >= v * 2);
}

/** Worker split that closes the gap to `wanted` fastest, keeping food non-negative. */
function steerToward(e: { food: number; wood: number; stone: number }, rates: { food: number }, wanted: Cost): { food: number; wood: number; stone: number } {
  const deficit = { food: Math.max(0, (wanted.food ?? 0) - e.food), wood: Math.max(0, (wanted.wood ?? 0) - e.wood), stone: Math.max(0, (wanted.stone ?? 0) - e.stone) };
  const total = deficit.food + deficit.wood + deficit.stone;
  if (total <= 0) return rates.food < 0 ? { food: 0.5, wood: 0.3, stone: 0.2 } : { food: 0.3, wood: 0.4, stone: 0.3 };
  const split = { food: 0.15 + 0.7 * (deficit.food / total), wood: 0.075 + 0.7 * (deficit.wood / total), stone: 0.075 + 0.7 * (deficit.stone / total) };
  if (rates.food < 0 || e.food < 100) split.food = Math.max(split.food, 0.45);
  return normalizeAssignment(split);
}

/** Move people, units and goods out of regions about to freeze into the safest owned region. */
async function retreatFromIce(
  ctx: CommandContext,
  owned: MatchRegionRow[],
  matchDay: number,
  horizonDays: number,
  attempt: (fn: () => Promise<unknown>) => Promise<boolean>,
  settlingTo: Set<string>,
  queueLen: (regionId: string) => number,
): Promise<void> {
  const { db, m } = ctx;
  const safety = (id: string) => freezeDayForLatitude(Math.abs(regionById(id)!.lat)) ?? 999;
  const safe = owned.filter((r) => !r.frozenAt && safety(r.regionId) - matchDay > horizonDays + 5).sort((a, b) => safety(b.regionId) - safety(a.regionId));
  if (!safe.length) {
    // Nowhere safe yet: the most threatened region sends (or trains) settlers toward safer free land.
    if (settlingTo.size > 0) return;
    const threatened = owned.filter((r) => !r.frozenAt && safety(r.regionId) - matchDay <= horizonDays + 3).sort((a, b) => safety(a.regionId) - safety(b.regionId));
    const row = threatened[0];
    if (!row) return;
    const need = balance.settle.settlersRequired;
    if ((row.units.settler ?? 0) >= need) {
      const free = await freeFrontier(db, m.id, owned.map((r) => r.regionId), (id) => safety(id) - matchDay > horizonDays + 8);
      const target = free.sort((a, b) => safety(b) - safety(a) || distanceKm(row.regionId, a) - distanceKm(row.regionId, b))[0];
      if (target) await attempt(() => sendArmy(ctx, row.regionId, { mission: "settle", targetRegionId: target, units: { settler: need }, people: 0, cargo: {} }));
    } else if (queueLen(row.regionId) < balance.queue.slotsPerRegion) {
      await attempt(() => queueTrain(ctx, row.regionId, "settler", need));
    }
    return;
  }
  for (const row of owned) {
    if (row.frozenAt) continue;
    if (safety(row.regionId) - matchDay > horizonDays) continue;
    const dest = safe.sort((a, b) => distanceKm(row.regionId, a.regionId) - distanceKm(row.regionId, b.regionId))[0]!;
    if (dest.regionId === row.regionId) continue;
    const people = Math.floor(row.popWorkers * 0.8);
    const cargo: Record<string, number> = { food: Math.floor(row.food * 0.8), wood: Math.floor(row.wood * 0.8), stone: Math.floor(row.stone * 0.8) };
    const units = { ...row.units };
    if (people < 1 && Object.values(units).every((n) => n <= 0)) continue;
    await attempt(() => sendArmy(ctx, row.regionId, { mission: Object.values(units).some((n) => n > 0) ? "move" : "transport", targetRegionId: dest.regionId, units, people, cargo }));
  }
}

/** Unowned, uninhabited, non-tundra regions next to mine (optionally filtered), for settling. */
async function freeFrontier(db: Db, matchId: string, ownedIds: string[], ok: (id: string) => boolean = () => true): Promise<string[]> {
  const ids = [...new Set(ownedIds.flatMap((id) => regionById(id)?.neighbors ?? []))].filter((id) => !ownedIds.includes(id) && !regionById(id)!.terrain.startsWith("tundra") && ok(id));
  if (ids.length === 0) return [];
  const rows = await db
    .select({ regionId: matchRegions.regionId, owner: matchRegions.ownerPlayerId, pop: sql<number>`${matchRegions.popWorkers} + ${matchRegions.popSoldiers} + ${matchRegions.popOccupiers}` })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, matchId), inArray(matchRegions.regionId, ids)));
  const taken = new Set(rows.filter((r) => r.owner || r.pop >= 1).map((r) => r.regionId));
  return ids.filter((id) => !taken.has(id));
}

/** List surplus ore on the market so other tribes (and humans) can buy their way into the next age. */
async function sellOre(ctx: CommandContext, owned: MatchRegionRow[], now: Date): Promise<void> {
  const { db, m, p } = ctx;
  const open = await db
    .select({ offer: marketOrders.offerResource })
    .from(marketOrders)
    .where(and(eq(marketOrders.matchId, m.id), eq(marketOrders.playerId, p.id), eq(marketOrders.status, "open")));
  if (open.length >= 3) return;
  const listed = new Set(open.map((o) => o.offer));
  for (const row of owned) {
    if (row.frozenAt) continue;
    for (const ore of ["copper", "tin", "iron"] as const) {
      if (listed.has(ore)) continue;
      const have = (row.special as Record<string, number>)[ore] ?? 0;
      if (have <= balance.ai.oreListAbove) continue;
      const amount = Math.floor(have / 2);
      try {
        await db.transaction(async (tx) => {
          const locked = await settleAndLockRegion(tx, m.id, row.regionId, now, m.speed);
          if ((stockOf(locked)[ore] ?? 0) < amount) return;
          await applyCost(tx, locked, { [ore]: amount });
          await tx.insert(marketOrders).values({
            matchId: m.id,
            playerId: p.id,
            regionId: row.regionId,
            offerResource: ore,
            offerAmount: amount,
            askResource: "wood",
            askAmount: amount * balance.ai.oreAskWoodPerUnit,
            status: "open",
          });
        });
        listed.add(ore);
      } catch {
        // Market full or region changed hands; try again next pass.
      }
    }
  }
}
