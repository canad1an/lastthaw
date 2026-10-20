/**
 * Advisors: hired staff who take routine management off a player's hands for a steep hourly wage.
 * Today the Economic advisor: raises buildings across every region to the minimum levels the player set, lets the
 * materials routes and convoys supply what a region cannot pay, moves people the way the player chose, and writes
 * a short report with suggestions after every pass. Wages are charged by the match tick; passes run in the AI process.
 */
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type pino from "pino";
import { balance, availableBuildings, buildingBlockedBy, buildingById, buildingCost, canAfford, computeRates, normalizeAssignment, regionById, unitById, HAULER_IDS, type AdvisorKind, type AdvisorSettings, type AdvisorReport, type AdvisorSuggestion, type Cost, type RegionEconomy, advisorSettings as advisorSettingsSchema } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { advisors, jobs, matchRegions, matches, playerTechs, players, tradeRoutes } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { matchDayAt, matchNow } from "./clock.js";
import { applyCost, ownerTechEffects, projectRegion, settleAndLockRegion, stockOf, resourceMultOf, traitsOf, type MatchRegionRow, type Tx } from "./regions.js";
import { queueBuild, sendArmy, type CommandContext } from "./commands.js";
import { recordSpend } from "./ledger.js";
import { buildOrderFor } from "./ai.js";
import { notify, type MatchRow } from "../worker/jobs.js";

type PlayerRow = typeof players.$inferSelect;
export type AdvisorRow = typeof advisors.$inferSelect;

const hourMs = (m: MatchRow) => 3600_000 / m.speed;

export const ADVISOR_NAMES: Record<AdvisorKind, string> = { economic: "Mara, the Economic advisor", military: "Max, the Military advisor", thaw: "Freya, the Warden of the Thaw", chancellor: "Theo, the Chancellor" };
/** The short title used in messages: "Your Military advisor". */
export const ADVISOR_TITLES: Record<AdvisorKind, string> = { economic: "Economic advisor", military: "Military advisor", thaw: "Warden of the Thaw", chancellor: "Chancellor" };

/**
 * The hourly wage of any advisor for a player right now: balance.advisors.outputShare of the empire's gross output
 * of food, wood and stone across its unfrozen regions (gathering, before consumption), each rounded up. Ore and
 * horses are never part of the wage: they trickle in by the unit, the advisors spend them on the player's behalf
 * (bronze units, research), and one short ore would otherwise stop an advisor while the stores hold hundreds of
 * thousands of everything else. The same for every kind: four advisors take all the gathering.
 */
/** The resources an advisor is paid in. */
export const WAGE_RESOURCES = ["food", "wood", "stone"] as const;

export async function wageFor(db: Tx | Db, m: MatchRow, playerId: string): Promise<Record<string, number>> {
  const rows = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId), isNull(matchRegions.frozenAt)));
  const fx = await ownerTechEffects(db, playerId);
  const now = matchNow(m);
  const gross: Record<string, number> = {};
  for (const row of rows) {
    const { rates } = projectRegion(row, now, m.speed, fx, resourceMultOf(m));
    for (const k of WAGE_RESOURCES) gross[k] = (gross[k] ?? 0) + Math.max(0, rates.gross[k] ?? 0);
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(gross)) if (v > 0) out[k] = Math.max(1, Math.ceil(v * balance.advisors.outputShare));
  return out;
}

export function parseSettings(raw: unknown): AdvisorSettings {
  const r = advisorSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : advisorSettingsSchema.parse({});
}

/**
 * Take a wage from the empire: the capital first, then the other regions. Every region of the player is locked in
 * ascending order (the lock order used everywhere). Returns false, taking nothing, when any one resource is short.
 */
export async function drawWage(tx: Tx, m: MatchRow, p: PlayerRow, wage: Record<string, number>): Promise<boolean> {
  const mine = await tx
    .select({ regionId: matchRegions.regionId })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt)))
    .orderBy(asc(matchRegions.regionId));
  const now = matchNow(m);
  const rows: MatchRegionRow[] = [];
  for (const r of mine) rows.push(await settleAndLockRegion(tx, m.id, r.regionId, now, m.speed, resourceMultOf(m)));
  const capital = rows.find((r) => r.regionId === p.capitalRegionId);
  const ordered = capital ? [capital, ...rows.filter((r) => r !== capital)] : rows;
  const pooled: Record<string, number> = {};
  for (const r of ordered) for (const [k, v] of Object.entries(stockOf(r))) pooled[k] = (pooled[k] ?? 0) + v;
  for (const [k, v] of Object.entries(wage)) if ((pooled[k] ?? 0) < v) return false;
  const remaining: Record<string, number> = { ...wage };
  for (const r of ordered) {
    const have = stockOf(r);
    const take: Record<string, number> = {};
    for (const [k, v] of Object.entries(remaining)) {
      const t = Math.min(v, have[k] ?? 0);
      if (t > 0) take[k] = t;
    }
    if (Object.keys(take).length) {
      await applyCost(tx, r, take as Cost);
      await recordSpend(tx, m, p.id, "advisors", take);
      for (const [k, t] of Object.entries(take)) {
        remaining[k] = (remaining[k] ?? 0) - t;
        if (remaining[k]! <= 1e-9) delete remaining[k];
      }
    }
    if (Object.keys(remaining).length === 0) break;
  }
  return true;
}

export async function regionsHeld(tx: Tx | Db, m: MatchRow, playerId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId), isNull(matchRegions.frozenAt)));
  return r?.n ?? 0;
}

/**
 * Wages, every tick: each advisor is paid for every whole game hour that has passed since it was last paid for.
 * One that cannot be paid stops working (no passes) and its player is told once; it goes back to work when the next
 * charge succeeds. It never leaves on its own.
 */
export async function chargeAdvisors(tx: Tx, m: MatchRow, now: Date): Promise<void> {
  const rows = await tx.select().from(advisors).where(and(eq(advisors.matchId, m.id), isNull(advisors.firedAt), lte(advisors.paidUntil, now)));
  for (const a of rows) {
    const [p] = await tx.select().from(players).where(eq(players.id, a.playerId)).limit(1);
    if (!p || p.eliminatedAt) {
      await tx.delete(advisors).where(eq(advisors.id, a.id));
      continue;
    }
    const wage = await wageFor(tx, m, p.id);
    let paidUntil = a.paidUntil;
    let hours = 0;
    let paid = true;
    // At most two days of arrears in one go, so a long pause never drains an empire in a single tick.
    while (paidUntil <= now && hours < 48) {
      if (!(await drawWage(tx, m, p, wage))) {
        paid = false;
        break;
      }
      paidUntil = new Date(paidUntil.getTime() + hourMs(m));
      hours += 1;
    }
    if (hours > 0) await tx.update(advisors).set({ paidUntil }).where(eq(advisors.id, a.id));
    if (!paid) {
      if (!a.unpaidSince) {
        await tx.update(advisors).set({ unpaidSince: now }).where(eq(advisors.id, a.id));
        const line = Object.entries(wage)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ");
        await notify(tx, m.id, p.id, "system", `Your ${ADVISOR_TITLES[a.kind]} is unpaid and has stopped working: the wage is ${line} an hour, drawn from your capital first`, { advisor: a.kind, unpaid: true });
      }
    } else if (a.unpaidSince) {
      await tx.update(advisors).set({ unpaidSince: null }).where(eq(advisors.id, a.id));
      await notify(tx, m.id, p.id, "system", `Your ${ADVISOR_TITLES[a.kind]} has been paid and is back at work`, { advisor: a.kind, unpaid: false });
    }
  }
}

/** Players in a match whose people the game moves on its own: every AI tribe, and humans whose paid Economic advisor is set to overflow. */
export async function overflowPlayerIds(tx: Tx, m: MatchRow): Promise<string[]> {
  const ai = await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, m.id), eq(players.isAi, true), isNull(players.eliminatedAt)));
  const adv = await tx
    .select({ playerId: advisors.playerId })
    .from(advisors)
    .where(and(eq(advisors.matchId, m.id), eq(advisors.kind, "economic"), isNull(advisors.firedAt), isNull(advisors.unpaidSince), sql`${advisors.settings}->>'population' = 'overflow'`));
  return [...new Set([...ai.map((p) => p.id), ...adv.map((a) => a.playerId)])];
}

/** Advisor passes: every paid advisor whose turn has come, in the AI process (each command commits on its own). */
export async function runAdvisors(db: Db, publisher: Publisher, log: pino.Logger): Promise<number> {
  const running = await db.select().from(matches).where(and(eq(matches.status, "running"), isNull(matches.pausedAt)));
  let passes = 0;
  for (const m of running) {
    const now = matchNow(m);
    const rows = await db.select().from(advisors).where(and(eq(advisors.matchId, m.id), isNull(advisors.firedAt), isNull(advisors.unpaidSince)));
    for (const a of rows) {
      const due = new Date(now.getTime() - (balance.advisors[a.kind].passMinutes * 60_000) / m.speed);
      if (a.lastPassAt && a.lastPassAt > due) continue;
      try {
        const [p] = await db.select().from(players).where(eq(players.id, a.playerId)).limit(1);
        if (!p || p.eliminatedAt) continue;
        await runPass(db, m, p, a, now, publisher);
        passes += 1;
      } catch (err) {
        log.warn({ err, advisorId: a.id }, "advisor pass failed");
      }
    }
  }
  return passes;
}

/** A pass of whichever advisor this is. */
export async function runPass(db: Db, m: MatchRow, p: PlayerRow, a: AdvisorRow, now: Date, publisher: Publisher): Promise<AdvisorReport> {
  if (a.kind === "military") {
    const { militaryPass } = await import("./militaryAdvisor.js");
    return militaryPass(db, m, p, a, now, publisher);
  }
  if (a.kind === "thaw") {
    const { thawPass } = await import("./thawAdvisor.js");
    return thawPass(db, m, p, a, now, publisher);
  }
  if (a.kind === "chancellor") {
    const { chancellorPass } = await import("./chancellor.js");
    return chancellorPass(db, m, p, a, now, publisher);
  }
  return economicPass(db, m, p, a, now, publisher);
}

/** One pass of the Economic advisor: buildings up to the minimums, then people, then the report. */
export async function economicPass(db: Db, m: MatchRow, p: PlayerRow, a: AdvisorRow, now: Date, publisher: Publisher): Promise<AdvisorReport> {
  const c = balance.advisors.economic;
  const settings = parseSettings(a.settings);
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
  const techs = new Set(techRows.map((t) => t.id));
  const ctx: CommandContext = { db, m, p, techs };
  const owned = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt), isNull(matchRegions.evacuatedAt)));
  const pending = await db
    .select({ regionId: jobs.regionId, kind: jobs.kind, refId: jobs.refId, waitingFor: jobs.waitingFor, startsAt: jobs.startsAt })
    .from(jobs)
    .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, p.id), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
  const skip = new Set(settings.skipRegions);
  const skipped: Record<string, number> = {};
  const bump = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1);
  let queued = 0;
  // Builds waiting on materials pull haulers; the advisor keeps them few, and prefers builds a region can pay for itself.
  let waitingBuilds = pending.filter((j) => j.kind === "build" && j.waitingFor).length;
  const matchDay = matchDayAt(m, now);
  const avail = new Map(availableBuildings(p.age, techs).map((b) => [b.id, b]));

  // Buildings: the capital first, then the most populous regions; within a region the AI's order, with its nudges.
  const projected = owned.map((row) => ({ row, ...projectRegion(row, now, m.speed, undefined, resourceMultOf(m)) }));
  const pop = (x: (typeof projected)[number]) => x.economy.popWorkers + x.economy.popSoldiers + x.economy.popOccupiers;
  projected.sort((x, y) => Number(y.row.isCapital) - Number(x.row.isCapital) || pop(y) - pop(x));
  for (const { row, economy } of projected) {
    if (skip.has(row.regionId)) continue;
    if (queued >= c.maxQueuedPerPass) break;
    const region = regionById(row.regionId);
    if (!region) continue;
    const here = pending.filter((j) => j.regionId === row.regionId && (j.kind === "build" || j.kind === "train"));
    let slots = balance.queue.slotsPerRegion - here.length;
    const waitingHere = here.some((j) => j.kind === "build" && j.waitingFor);
    for (const id of buildOrderFor(row, economy, false)) {
      const target = Math.min(settings.minLevels[id] ?? 0, buildingById.get(id)?.maxLevel ?? 0);
      if (target <= 0) continue;
      const def = avail.get(id);
      if (!def) {
        bump("notYetAvailable");
        continue;
      }
      const have = (row.buildings[id] ?? 0) + here.filter((j) => j.kind === "build" && j.refId === id).length;
      if (have >= target) continue;
      if (buildingBlockedBy(def, region, row.buildings, row.isCapital)) {
        bump("blocked");
        continue;
      }
      if (slots <= 0) {
        bump("queueFull");
        break;
      }
      if (queued >= c.maxQueuedPerPass) break;
      const nextLevel = (row.buildings[id] ?? 0) + here.filter((j) => j.kind === "build" && j.refId === id).length + 1;
      const payable = canAfford(stockOf(row), buildingCost(def, nextLevel, matchDay, region.neighbors.length));
      const mayWait = settings.useOtherRegions && !waitingHere && waitingBuilds < c.maxWaitingBuilds;
      if (!payable && !mayWait) {
        bump(waitingBuilds >= c.maxWaitingBuilds ? "haulingBusy" : "unaffordable");
        continue;
      }
      try {
        await queueBuild(ctx, row.regionId, id, { allowWait: !payable && mayWait, maxOwed: c.maxOwed });
        queued += 1;
        slots -= 1;
        if (!payable) waitingBuilds += 1;
      } catch (err) {
        const msg = (err as Error).message ?? "";
        bump(/not enough|too much would have to be shipped/.test(msg) ? "unaffordable" : /queue is full/.test(msg) ? "queueFull" : "blocked");
      }
    }
  }

  // Workers: each region's shares from what it and the empire need.
  let rebalanced = 0;
  if (settings.workers) rebalanced = await rebalanceWorkers(db, m, projected, pending, skip, now);

  // People.
  let moved = 0;
  if (settings.population === "balanced") moved = await balancePeople(ctx, projected.map((x) => ({ row: x.row, economy: x.economy })), skip);

  const suggestions = await suggestionsFor(db, m, p, projected.map((x) => ({ row: x.row, economy: x.economy })), pending, settings, now);
  const report: AdvisorReport = { at: now.toISOString(), queued, moved, rebalanced, trained: 0, fortified: 0, exposed: [], evacuated: 0, settled: 0, clock: [], researched: 0, listed: 0, bought: 0, skipped, suggestions };
  await db.update(advisors).set({ lastPassAt: now, lastReport: report }).where(eq(advisors.id, a.id));
  await publisher.toPlayer(m.id, p.id, "advisor.report", { kind: a.kind, queued, moved });
  return report;
}

/**
 * Worker shares, region by region. Every split on a 10% grid is scored by what it would gather an hour, each resource
 * weighted by how badly it is wanted: full stores are worth nothing more, and a resource the empire's waiting builds owe
 * is worth more the longer the empire would take to gather it. Food is a floor, not a choice: a split that starves the
 * region (net food below zero with under half a day in store) is out. The best split replaces the current one when it
 * differs by a tenth or more in any share, so settings do not twitch every pass.
 */
export async function rebalanceWorkers(db: Db, m: MatchRow, regions: Array<{ row: MatchRegionRow; economy: RegionEconomy }>, pending: Array<{ regionId: string | null; kind: string; waitingFor: unknown }>, skip: Set<string>, now: Date): Promise<number> {
  const live = regions.filter((x) => !skip.has(x.row.regionId) && x.economy.popWorkers >= 1);
  if (!live.length) return 0;
  // The empire's gathering per hour as it stands, and what its waiting builds still owe.
  const gross = { food: 0, wood: 0, stone: 0 };
  const owed = { food: 0, wood: 0, stone: 0 };
  const traitsOfRegion = new Map(live.map((x) => [x.row.regionId, traitsOf(x.row.regionId)]));
  for (const x of live) {
    const r = computeRates(traitsOfRegion.get(x.row.regionId)!, x.economy);
    gross.food += r.gross.food;
    gross.wood += r.gross.wood;
    gross.stone += r.gross.stone;
  }
  for (const j of pending) {
    if (j.kind !== "build" || !j.waitingFor) continue;
    for (const [k, v] of Object.entries(j.waitingFor as Record<string, number>)) if (k in owed) owed[k as keyof typeof owed] += v;
  }
  // Worth of one more unit an hour: 1 for a resource nobody is short of, up to 3 when the empire owes a day of it.
  const need = { food: 1, wood: 1 + Math.min(2, owed.wood / Math.max(1, gross.wood * 12)), stone: 1 + Math.min(2, owed.stone / Math.max(1, gross.stone * 12)) };
  const grid: Array<{ food: number; wood: number; stone: number }> = [];
  for (let f = 1; f <= 8; f++) for (let w = 0; w <= 10 - f; w++) grid.push({ food: f / 10, wood: w / 10, stone: (10 - f - w) / 10 });
  let changed = 0;
  for (const x of live) {
    const traits = traitsOfRegion.get(x.row.regionId)!;
    const e = x.economy;
    const fill = { food: e.food / Math.max(1, e.storage.food), wood: e.wood / Math.max(1, e.storage.wood), stone: e.stone / Math.max(1, e.storage.stone) };
    // A full store is worth nothing more; a low one is worth the most. The empire's need scales that.
    const worth = (k: "food" | "wood" | "stone") => need[k] * Math.max(0, 1 - Math.min(1, fill[k] / 0.95));
    const current = normalizeAssignment(e.assignment);
    let best = current;
    let bestScore = -Infinity;
    let any = false;
    for (const a of grid) {
      const r = computeRates(traits, { ...e, assignment: a });
      const consumption = r.gross.food - r.food;
      const starving = r.food < 0 && e.food < consumption * 12;
      if (starving) continue;
      any = true;
      // Food beyond what the region eats is worth its store-weighted value; what it eats is worth keeping no matter what.
      const score = Math.min(r.gross.food, consumption) * 1.5 + Math.max(0, r.gross.food - consumption) * worth("food") + r.gross.wood * worth("wood") + r.gross.stone * worth("stone");
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = a;
      }
    }
    if (!any) best = { food: 0.8, wood: 0.1, stone: 0.1 };
    const differs = Math.abs(best.food - current.food) >= 0.1 || Math.abs(best.wood - current.wood) >= 0.1 || Math.abs(best.stone - current.stone) >= 0.1;
    if (!differs) continue;
    await db.transaction(async (tx) => {
      const row = await settleAndLockRegion(tx, m.id, x.row.regionId, now, m.speed, resourceMultOf(m));
      if (row.ownerPlayerId !== x.row.ownerPlayerId) return;
      await tx.update(matchRegions).set({ assignment: best }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, x.row.regionId)));
      changed += 1;
    });
  }
  return changed;
}

/**
 * Balanced population: every region toward the same share of its capacity. Regions above the mean by more than the
 * band send a slice of their workers to the emptiest reachable region below the mean, as a column of people on the road.
 */
export async function balancePeople(ctx: CommandContext, regions: Array<{ row: MatchRegionRow; economy: { popWorkers: number; popSoldiers: number; popOccupiers: number; capacity: number } }>, skip: Set<string>): Promise<number> {
  const c = balance.advisors.economic;
  const live = regions.filter((x) => !skip.has(x.row.regionId));
  if (live.length < 2) return 0;
  const pop = (x: (typeof live)[number]) => x.economy.popWorkers + x.economy.popSoldiers + x.economy.popOccupiers;
  const fill = (x: (typeof live)[number]) => pop(x) / Math.max(1, x.economy.capacity);
  const totalPop = live.reduce((a, x) => a + pop(x), 0);
  const totalCap = live.reduce((a, x) => a + Math.max(1, x.economy.capacity), 0);
  const mean = totalPop / totalCap;
  const givers = live.filter((x) => fill(x) > mean + c.balanceBand && x.economy.popWorkers > 1).sort((x, y) => fill(y) - fill(x));
  const takers = live.filter((x) => fill(x) < mean - c.balanceBand);
  let moved = 0;
  const promised = new Map<string, number>();
  for (const g of givers) {
    const movers = Math.floor(Math.min(Math.floor(g.economy.popWorkers) - 1, pop(g) * c.balanceSharePerPass, pop(g) - mean * g.economy.capacity));
    if (movers < 1) continue;
    // The emptiest taker with room, nearest among equals.
    const ranked = takers
      .map((t) => ({ t, room: Math.floor(mean * t.economy.capacity - pop(t) - (promised.get(t.row.regionId) ?? 0)) }))
      .filter((x) => x.room >= 1)
      .sort((p1, p2) => fill(p1.t) - fill(p2.t) || distance(g.row.regionId, p1.t.row.regionId) - distance(g.row.regionId, p2.t.row.regionId));
    const pick = ranked[0];
    if (!pick) break;
    const n = Math.min(movers, pick.room);
    try {
      await sendArmy(ctx, g.row.regionId, { mission: "move", targetRegionId: pick.t.row.regionId, units: {}, people: n, cargo: {} });
      moved += n;
      promised.set(pick.t.row.regionId, (promised.get(pick.t.row.regionId) ?? 0) + n);
    } catch {
      // No land route, or the region changed under us: try the next giver.
    }
  }
  return moved;
}

function distance(a: string, b: string): number {
  const ra = regionById(a);
  const rb = regionById(b);
  if (!ra || !rb) return 0;
  return Math.hypot(ra.x - rb.x, ra.y - rb.y);
}

/** Cheap, honest advice from what the pass already knows. Each line names a region so the panel can open it. */
export async function suggestionsFor(
  db: Db,
  m: MatchRow,
  p: PlayerRow,
  regions: Array<{ row: MatchRegionRow; economy: { food: number; wood: number; stone: number; storage: { food: number; wood: number; stone: number }; popWorkers: number; popSoldiers: number; popOccupiers: number; capacity: number } }>,
  pending: Array<{ regionId: string | null; kind: string; refId: string | null; waitingFor: unknown; startsAt: Date }>,
  settings: AdvisorSettings,
  now: Date,
): Promise<AdvisorSuggestion[]> {
  const out: AdvisorSuggestion[] = [];
  const routes = await db.select({ fromRegionId: tradeRoutes.fromRegionId, enabled: tradeRoutes.enabled }).from(tradeRoutes).where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.playerId, p.id)));
  const routeOut = new Set(routes.filter((r) => r.enabled).map((r) => r.fromRegionId));
  const name = (id: string) => regionById(id)?.name ?? id;
  for (const { row, economy } of regions) {
    const full = (["food", "wood", "stone"] as const).filter((k) => economy[k] >= economy.storage[k] * 0.9);
    if (full.length && !routeOut.has(row.regionId) && !row.isCapital) {
      const storeMin = Math.max(settings.minLevels.storehouse ?? 0, settings.minLevels.granary ?? 0);
      out.push({ regionId: row.regionId, text: `${name(row.regionId)} is near its cap for ${full.join(", ")} with no route out: ${storeMin > (row.buildings.storehouse ?? 0) ? "a Storehouse is on its way" : "raise the Storehouse minimum or set up a route"}.` });
    }
    const pop = economy.popWorkers + economy.popSoldiers + economy.popOccupiers;
    if (pop >= economy.capacity * 0.9 && (row.buildings.huts ?? 0) >= (settings.minLevels.huts ?? 0)) {
      out.push({ regionId: row.regionId, text: `${name(row.regionId)} is nearly full (${Math.round(pop)} of ${Math.round(economy.capacity)}): raise the Huts minimum${settings.population === "off" ? ", or let the advisor move people" : ""}.` });
    }
    const region = regionById(row.regionId);
    if (region) {
      const ore = region.resources.filter((r) => r === "copper" || r === "tin" || r === "iron");
      if (ore.length && !(row.buildings.mine ?? 0) && !(settings.minLevels.mine ?? 0)) out.push({ regionId: row.regionId, text: `${name(row.regionId)} has ${ore.join(" and ")} and no Mine: set a Mine minimum to use it.` });
      if (region.resources.includes("horses") && !(row.buildings.stables ?? 0) && !(settings.minLevels.stables ?? 0)) out.push({ regionId: row.regionId, text: `${name(row.regionId)} has horses and no Stables: set a Stables minimum.` });
    }
    const idle = HAULER_IDS.filter((id) => !unitById.get(id)?.naval).reduce((a, id) => a + (row.units[id] ?? 0), 0);
    if (idle > 0 && !routeOut.has(row.regionId)) out.push({ regionId: row.regionId, text: `${idle} hauler${idle === 1 ? "" : "s"} idle in ${name(row.regionId)} with no route; the pool will call them when a route runs short.` });
  }
  for (const j of pending) {
    if (j.kind !== "build" || !j.waitingFor || !j.regionId) continue;
    const hours = ((now.getTime() - j.startsAt.getTime()) / 3600_000) * m.speed;
    if (hours >= 6) {
      const owed = Object.entries(j.waitingFor as Record<string, number>)
        .map(([k, v]) => `${Math.round(v)} ${k}`)
        .join(", ");
      out.push({ regionId: j.regionId, text: `${buildingById.get(j.refId ?? "")?.name ?? j.refId} in ${name(j.regionId)} has waited ${Math.round(hours)} h for ${owed}${settings.useOtherRegions ? "" : ": allow other regions' resources"}.` });
    }
  }
  return out.slice(0, 12);
}

