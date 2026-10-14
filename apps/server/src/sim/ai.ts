import { and, eq, inArray, isNull } from "drizzle-orm";
import { availableBuildings, availableTechs, availableUnits, balance, effectsOf, regionById, seededRng, normalizeAssignment } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, jobs, matchRegions, playerTechs, players } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { projectRegion, settleAndLockRegion } from "./regions.js";
import { queueBuild, queueResearch, queueTrain, sendArmy, type CommandContext, type PlayerRow } from "./commands.js";
import { areAllied } from "./alliances.js";
import type { MatchRow } from "../worker/jobs.js";

const BUILD_ORDER = ["huts", "hunting_grounds", "storehouse", "lumber_camp", "quarry", "farm", "palisade", "granary", "mine", "stables", "walls", "barracks", "roads", "temple", "forge", "market", "aqueduct", "fort", "library", "harbor", "windmill", "castle", "guild_hall", "university", "cathedral"];
const RESEARCH_ORDER = ["fire_making", "flint_tools", "agriculture", "animal_husbandry", "bronze_working", "mining", "writing", "the_wheel", "iron_working", "masonry", "siegecraft", "drill", "engineering", "shipbuilding", "chivalry", "siege_engines", "scholasticism"];

/**
 * One round of decisions for an AI tribe. Uses the same commands as humans.
 * Each action is independent: a failure (cannot afford, queue full) is ignored.
 */
export async function runAiPlayer(db: Db, m: MatchRow, p: PlayerRow, now: Date, _publisher: Publisher): Promise<void> {
  const profile = p.aiProfile ?? "balanced";
  const rng = seededRng(`${m.seed}:${p.id}:${now.getTime()}`);
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
  const techs = new Set(techRows.map((t) => t.id));
  const ctx: CommandContext = { db, m, p, techs };
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      /* expected: unaffordable, queue full, no route */
    }
  };

  const owned = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id)));
  const pendingJobs = await db
    .select({ regionId: jobs.regionId, kind: jobs.kind })
    .from(jobs)
    .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, p.id), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
  const researching = pendingJobs.some((j) => j.kind === "research");
  const queueLen = (regionId: string) => pendingJobs.filter((j) => j.regionId === regionId).length;

  for (const row of owned) {
    if (row.frozenAt) continue;
    const { economy, rates } = projectRegion(row, now, m.speed);
    const pop = economy.popWorkers + economy.popSoldiers + economy.popOccupiers;

    // Economy: keep people fed, otherwise a balanced split with a stone lean when stone is short.
    const want = rates.food < 0 || economy.food < 60 ? { food: 0.7, wood: 0.2, stone: 0.1 } : economy.stone < 80 ? { food: 0.5, wood: 0.2, stone: 0.3 } : { food: 0.5, wood: 0.3, stone: 0.2 };
    const cur = normalizeAssignment(row.assignment);
    if (Math.abs(cur.food - want.food) > 0.05 || Math.abs(cur.stone - want.stone) > 0.05) {
      await attempt(() =>
        db.transaction(async (tx) => {
          await settleAndLockRegion(tx, m.id, row.regionId, now, m.speed);
          await tx.update(matchRegions).set({ assignment: want }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, row.regionId)));
        }),
      );
    }

    // Buildings: first affordable in priority order, with sensible nudges.
    let slots = balance.queue.slotsPerRegion - queueLen(row.regionId);
    if (slots > 0) {
      const avail = new Map(availableBuildings(p.age, techs).map((b) => [b.id, b]));
      const order = [...BUILD_ORDER];
      if (pop / economy.capacity > 0.75) order.unshift("huts");
      if (economy.food > economy.storage.food * 0.85 || economy.wood > economy.storage.wood * 0.85) order.unshift("storehouse");
      const region = regionById(row.regionId)!;
      for (const id of order) {
        if (slots <= 0) break;
        const def = avail.get(id);
        if (!def) continue;
        if (def.effect.extract && !Object.keys(def.effect.extract).some((r) => (region.resources as readonly string[]).includes(r))) continue;
        if (id === "harbor" && !region.coastal) continue;
        const level = row.buildings[id] ?? 0;
        if (level >= Math.min(def.maxLevel, 6 + p.age * 2)) continue;
        const before = slots;
        await attempt(async () => {
          await queueBuild(ctx, row.regionId, id);
          slots -= 1;
        });
        if (slots === before && rng() < 0.5) break; // could not afford the top priority; save up half the time
      }
    }

    // Soldiers: keep a share of the population under arms.
    const share = balance.ai.soldierShare[profile] ?? 0.2;
    if (queueLen(row.regionId) < balance.queue.slotsPerRegion && economy.popSoldiers < pop * share && economy.popWorkers > 8) {
      const units = availableUnits(p.age, techs).filter((u) => !u.needsResource || regionById(row.regionId)!.resources.includes(u.needsResource));
      const best = [...units].sort((a, b) => b.attack + b.defense - (a.attack + a.defense))[0];
      if (best) await attempt(() => queueTrain(ctx, row.regionId, best.id, Math.max(1, Math.min(10, Math.floor(economy.popWorkers * 0.15)))));
    }
  }

  // Research: next in order that is available.
  if (!researching) {
    const avail = new Set(availableTechs(p.age, techs).map((t) => t.id));
    const next = RESEARCH_ORDER.find((t) => avail.has(t));
    if (next) await attempt(() => queueResearch(ctx, next));
  }

  // Aggression: raid or conquer a weak neighbour.
  const raidChance = balance.ai.raidChance[profile] ?? 0.15;
  const conquerChance = balance.ai.conquerChance[profile] ?? 0.2;
  const inFlight = await db
    .select({ id: armies.id })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), inArray(armies.status, ["outbound", "returning"])));
  if (inFlight.length < 2 && owned.length > 0) {
    const roll = rng();
    if (roll < raidChance + conquerChance) {
      const wantConquer = roll >= raidChance;
      const strong = [...owned].sort((a, b) => b.popSoldiers - a.popSoldiers)[0]!;
      const soldiers = Object.values(strong.units).reduce((a, b) => a + b, 0);
      if (soldiers >= 6) {
        const neighbours = regionById(strong.regionId)!.neighbors;
        const rows = await db
          .select()
          .from(matchRegions)
          .where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, neighbours)));
        const byId = new Map(rows.map((r) => [r.regionId, r]));
        const owners = await db
          .select()
          .from(players)
          .where(and(eq(players.matchId, m.id), inArray(players.id, rows.map((r) => r.ownerPlayerId).filter((x): x is string => !!x).concat(p.id))));
        const ownerById = new Map(owners.map((o) => [o.id, o]));
        const candidates: Array<{ id: string; defenders: number; neutral: boolean }> = [];
        for (const n of neighbours) {
          const r = byId.get(n);
          const owner = r?.ownerPlayerId ?? null;
          if (owner === p.id) continue;
          if (owner && (await areAllied(db, m.id, p.id, owner))) continue;
          const o = owner ? ownerById.get(owner) : null;
          if (o?.protectionUntil && o.protectionUntil.getTime() > now.getTime()) continue;
          const defenders = r ? Object.values(r.units).reduce((a, b) => a + b, 0) + (r.popWorkers / 10) * balance.combat.militiaPerTenPeople : 0;
          if (defenders > soldiers * balance.ai.maxTargetStrengthRatio) continue;
          if (wantConquer && owner && !o?.isAi) continue; // conquest only against neutral or other AI, raids against anyone
          candidates.push({ id: n, defenders, neutral: !owner });
        }
        candidates.sort((a, b) => a.defenders - b.defenders);
        const target = candidates[0];
        if (target) {
          const send: Record<string, number> = {};
          for (const [id, n] of Object.entries(strong.units)) send[id] = Math.floor(n * 0.7);
          const people = wantConquer ? balance.conquest.occupiersRequired + 2 : 0;
          if (!wantConquer || strong.popWorkers > people + 10) {
            await attempt(() => sendArmy(ctx, strong.regionId, { mission: wantConquer ? "conquer" : "raid", targetRegionId: target.id, units: send, people, cargo: {} }));
          }
        }
      }
    }
  }

  const { min, max } = balance.ai.decisionMinutes;
  const minutes = min + rng() * (max - min);
  await db.update(players).set({ nextAiAt: new Date(now.getTime() + (minutes * 60 * 1000) / m.speed) }).where(eq(players.id, p.id));
}

/** Pick a profile for a new AI tribe. */
export function randomProfile(rng: () => number): string {
  const r = rng();
  return r < 0.3 ? "peaceful" : r < 0.75 ? "balanced" : "raider";
}
