import { and, eq, inArray, isNotNull, isNull, sql, gt } from "drizzle-orm";
import { allRegions, balance, distanceKm, effectsOf, applyTechEffects, iceLatitudeOnDay, regionById, armySpeed, travelSeconds, findRoute, type UnitCounts } from "@lastthaw/shared";
import { armies, events, jobs, matchRegions, players } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { ownerTechEffects, settleAndLockRegion, type MatchRegionRow, type Tx } from "./regions.js";
import { notify, type JobRow, type MatchRow } from "../worker/jobs.js";

type After = (fn: () => Promise<void>) => void;

/** Game hours → real milliseconds at this match's speed. */
const hoursMs = (m: MatchRow, h: number) => (h * 3600_000) / m.speed;

/** The hidden player the hordes belong to, if the match has one. */
export async function hordePlayer(tx: Tx, matchId: string): Promise<{ id: string; name: string } | null> {
  const [p] = await tx.select({ id: players.id, name: players.name }).from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, true))).limit(1);
  return p ?? null;
}

/**
 * Once per match day: blizzard warnings, plague, rich finds and the hordes.
 * Called from the tick when the day number has moved on since the last tick.
 */
export async function runDailyEvents(tx: Tx, m: MatchRow, now: Date, day: number, rng: () => number, publisher: Publisher, after: After): Promise<void> {
  await scheduleBlizzard(tx, m, now, day, rng);
  await spreadPlague(tx, m, now, day, rng);
  await richFind(tx, m, now, day, rng);
  await raiseHorde(tx, m, now, day, rng, after, publisher);
}

/** Every human in the match, for broadcast messages. */
async function humans(tx: Tx, matchId: string): Promise<string[]> {
  return (await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, matchId), eq(players.isAi, false)))).map((p) => p.id);
}

async function ownedRows(tx: Tx, matchId: string): Promise<MatchRegionRow[]> {
  return tx
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, matchId), isNotNull(matchRegions.ownerPlayerId), isNull(matchRegions.frozenAt), isNull(matchRegions.evacuatedAt)))
    .orderBy(matchRegions.regionId);
}

// ---------------------------------------------------------------- blizzards

async function scheduleBlizzard(tx: Tx, m: MatchRow, now: Date, day: number, rng: () => number): Promise<void> {
  const c = balance.events.storm;
  if (day < c.fromDay || rng() >= c.chance) return;
  const lat = iceLatitudeOnDay(day + 1);
  const candidates = allRegions().filter((r) => Math.abs(r.lat) < lat);
  const centre = candidates[Math.floor(rng() * candidates.length)];
  if (!centre) return;
  const regionIds = candidates.filter((r) => distanceKm(centre.id, r.id) <= c.radiusKm).map((r) => r.id);
  const hits = new Date(now.getTime() + hoursMs(m, c.warningHours));
  await tx.insert(jobs).values({ matchId: m.id, kind: "storm", payload: { regions: regionIds, centre: centre.id }, startsAt: now, endsAt: hits });
  await tx.insert(events).values({ matchId: m.id, at: now, kind: "storm.warning", payload: { centre: centre.id, regions: regionIds.length, hitsAt: hits.toISOString(), day } });
  const owners = await tx
    .select({ owner: matchRegions.ownerPlayerId, regionId: matchRegions.regionId })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, regionIds), isNotNull(matchRegions.ownerPlayerId)));
  const byOwner = new Map<string, string[]>();
  for (const o of owners) byOwner.set(o.owner!, [...(byOwner.get(o.owner!) ?? []), o.regionId]);
  for (const [owner, ids] of byOwner) {
    const names = ids.slice(0, 4).map((id) => regionById(id)?.name ?? id).join(", ") + (ids.length > 4 ? ` and ${ids.length - 4} more` : "");
    await notify(tx, m.id, owner, "system", `A blizzard is coming: in a day it reaches ${names}. Production halves and travel doubles for ${c.hours} hours while it blows.`, { regions: ids, hitsAt: hits.toISOString(), storm: true });
  }
}

/** The storm job completes: the regions are in the blizzard for `hours`. */
export async function stormHits(tx: Tx, m: MatchRow, job: JobRow, publisher: Publisher, after: After): Promise<void> {
  const c = balance.events.storm;
  const { regions: regionIds = [], centre } = job.payload as { regions?: string[]; centre?: string };
  if (regionIds.length === 0) return;
  const until = new Date(job.endsAt.getTime() + hoursMs(m, c.hours));
  // Settle first so production up to now is credited at the old rate, then flip the flag.
  const rows = await tx
    .select({ regionId: matchRegions.regionId })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, regionIds), isNull(matchRegions.frozenAt)))
    .orderBy(matchRegions.regionId);
  for (const r of rows) {
    await settleAndLockRegion(tx, m.id, r.regionId, job.endsAt, m.speed);
    await tx.update(matchRegions).set({ stormUntil: until }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
  }
  await tx.insert(events).values({ matchId: m.id, at: job.endsAt, kind: "storm.hit", payload: { centre, regions: regionIds.length, until: until.toISOString() } });
  after(() => publisher.toMatch(m.id, "region.updated", { storm: { regions: regionIds, until: until.toISOString() } }));
}

/** Is a trip through these regions slowed by a blizzard right now? */
export async function stormFactorFor(tx: Tx, matchId: string, path: readonly string[], at: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, matchId), inArray(matchRegions.regionId, [...path]), gt(matchRegions.stormUntil, at)));
  return (row?.n ?? 0) > 0 ? balance.events.storm.travel : 1;
}

// ---------------------------------------------------------------- plague

async function spreadPlague(tx: Tx, m: MatchRow, now: Date, day: number, rng: () => number): Promise<void> {
  const c = balance.events.plague;
  const rows = await ownedRows(tx, m.id);
  const fxByOwner = new Map<string, Awaited<ReturnType<typeof ownerTechEffects>>>();
  const until = new Date(now.getTime() + hoursMs(m, c.hours));
  for (const r of rows) {
    if (r.plagueUntil && r.plagueUntil > now) continue;
    const fx = fxByOwner.get(r.ownerPlayerId!) ?? fxByOwner.set(r.ownerPlayerId!, await ownerTechEffects(tx, r.ownerPlayerId)).get(r.ownerPlayerId!)!;
    if (fx.plagueResist >= 1) continue;
    const capacity = balance.economy.baseCapacity + applyTechEffects(effectsOf(r.buildings), fx).capacity;
    const pop = r.popWorkers + r.popSoldiers + r.popOccupiers;
    if (pop <= capacity * c.crowding) continue;
    if (rng() >= c.chance * (1 - fx.plagueResist)) continue;
    await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed);
    await tx.update(matchRegions).set({ plagueUntil: until }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
    const name = regionById(r.regionId)?.name ?? r.regionId;
    await notify(tx, m.id, r.ownerPlayerId!, "battle", `Sickness in ${name}: too many people in too little room. Growth stops and ${Math.round(c.deathPerHour * 100)}% die each hour for ${c.hours} hours. Herbal medicine halves the risk; Vaccination and Sanitation end it.`, { regionId: r.regionId, until: until.toISOString(), plague: true });
    await tx.insert(events).values({ matchId: m.id, at: now, kind: "plague.outbreak", payload: { regionId: r.regionId, playerId: r.ownerPlayerId, day } });
  }
}

// ---------------------------------------------------------------- rich finds

async function richFind(tx: Tx, m: MatchRow, now: Date, day: number, rng: () => number): Promise<void> {
  const c = balance.events.boom;
  if (rng() >= c.chance) return;
  const rows = (await ownedRows(tx, m.id)).filter((r) => !(r.boom && new Date(r.boom.until) > now));
  const pick = rows.filter((r) => (r.buildings.mine ?? 0) > 0 || (r.buildings.quarry ?? 0) > 0 || (r.buildings.lumber_camp ?? 0) > 0);
  const r = pick[Math.floor(rng() * pick.length)];
  if (!r) return;
  const region = regionById(r.regionId)!;
  const options: string[] = [];
  if ((r.buildings.mine ?? 0) > 0) for (const s of ["iron", "copper", "tin"] as const) if ((region.resources as readonly string[]).includes(s)) options.push(s);
  if ((r.buildings.quarry ?? 0) > 0) options.push("stone");
  if ((r.buildings.lumber_camp ?? 0) > 0) options.push("wood");
  const resource = options[Math.floor(rng() * options.length)];
  if (!resource) return;
  const until = new Date(now.getTime() + hoursMs(m, c.hours));
  await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed);
  await tx.update(matchRegions).set({ boom: { resource, until: until.toISOString() } }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
  await notify(tx, m.id, r.ownerPlayerId!, "system", `A rich vein of ${resource} in ${region.name}: output doubles for ${c.hours} hours. Your neighbours have heard.`, { regionId: r.regionId, resource, until: until.toISOString(), boom: true });
  // The neighbours hear of it: a tempting target.
  const neighbours = await tx
    .select({ owner: matchRegions.ownerPlayerId })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, region.neighbors), isNotNull(matchRegions.ownerPlayerId)));
  for (const owner of new Set(neighbours.map((n) => n.owner!))) {
    if (owner === r.ownerPlayerId) continue;
    await notify(tx, m.id, owner, "scout", `Word from the border: ${region.name} has struck a rich vein of ${resource}. Its stores will fill fast for ${c.hours} hours.`, { regionId: r.regionId, resource, boom: true });
  }
  await tx.insert(events).values({ matchId: m.id, at: now, kind: "boom.found", payload: { regionId: r.regionId, playerId: r.ownerPlayerId, resource, day } });
}

// ---------------------------------------------------------------- hordes

async function raiseHorde(tx: Tx, m: MatchRow, now: Date, day: number, rng: () => number, after: After, publisher: Publisher): Promise<void> {
  const c = balance.events.horde;
  if (day < c.fromDay) return;
  if (rng() >= (day >= c.lateDay ? c.lateChance : c.chance)) return;
  const horde = await hordePlayer(tx, m.id);
  if (!horde) return;
  const lat = iceLatitudeOnDay(day);
  // A camp just inside the ice line, with nobody living there.
  const band = allRegions().filter((r) => Math.abs(r.lat) < lat && Math.abs(r.lat) >= lat - c.bandDeg && r.terrain !== "tundra");
  if (band.length === 0) return;
  const owned = await ownedRows(tx, m.id);
  const takenIds = new Set(owned.map((r) => r.regionId));
  const camps = band.filter((r) => !takenIds.has(r.id));
  if (camps.length === 0) return;
  // Aim at the most populous empire region within reach of some camp: the richest prey in the north.
  let best: { camp: string; target: MatchRegionRow; dist: number } | null = null;
  for (const t of owned) {
    const pop = t.popWorkers + t.popSoldiers + t.popOccupiers;
    if (pop < 20) continue;
    for (const camp of camps) {
      const d = distanceKm(camp.id, t.regionId);
      if (d > c.reachKm) continue;
      const score = pop / (1 + d / 500);
      if (!best || score > best.dist) best = { camp: camp.id, target: t, dist: score };
    }
  }
  if (!best) return;
  const size = c.base + c.perDay * (day - c.fromDay);
  const units: UnitCounts = { warrior: Math.round(size * 0.6), swordsman: Math.round(size * 0.4) };
  if (day >= c.catapultsFromDay) units.catapult = Math.max(2, Math.round(size / 8));
  const route = findRoute(best.camp, best.target.regionId, false) ?? { path: [best.camp, best.target.regionId], cost: distanceKm(best.camp, best.target.regionId), usesSea: false };
  const seconds = travelSeconds(route, armySpeed(units), m.speed);
  const arrivesAt = new Date(now.getTime() + seconds * 1000);
  const [a] = await tx
    .insert(armies)
    .values({ matchId: m.id, playerId: horde.id, mission: "raid", originRegionId: best.camp, targetRegionId: best.target.regionId, units, cargo: {}, path: route.path, status: "outbound", departsAt: now, arrivesAt })
    .returning();
  await tx.insert(jobs).values({ matchId: m.id, playerId: horde.id, regionId: best.target.regionId, kind: "mission", refId: a!.id, startsAt: now, endsAt: arrivesAt });
  const targetName = regionById(best.target.regionId)?.name ?? best.target.regionId;
  const campName = regionById(best.camp)?.name ?? best.camp;
  await notify(tx, m.id, best.target.ownerPlayerId!, "battle", `${horde.name} has come down from ${campName} and marches on ${targetName}: about ${Math.round(size / 10) * 10} fighters${units.catapult ? " with siege engines" : ""}. Walls and a garrison will hold them; empty land will not.`, { regionId: best.target.regionId, arrivesAt: arrivesAt.toISOString(), horde: true });
  const region = regionById(best.target.regionId)!;
  const neighbours = await tx
    .select({ owner: matchRegions.ownerPlayerId })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, region.neighbors), isNotNull(matchRegions.ownerPlayerId)));
  for (const owner of new Set(neighbours.map((n) => n.owner!))) {
    if (owner === best.target.ownerPlayerId) continue;
    await notify(tx, m.id, owner, "scout", `${horde.name} is on the march near your border, heading for ${targetName}.`, { regionId: best.target.regionId, horde: true });
  }
  await tx.insert(events).values({ matchId: m.id, at: now, kind: "horde.sighted", payload: { camp: best.camp, regionId: best.target.regionId, playerId: best.target.ownerPlayerId, size, day } });
  const targetOwner = best.target.ownerPlayerId!;
  const targetId = best.target.regionId;
  after(() => publisher.toPlayer(m.id, targetOwner, "army.incoming", { targetRegionId: targetId, arrivesAt: arrivesAt.toISOString() }));
  void humans;
}
