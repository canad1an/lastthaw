import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type pino from "pino";
import { balance, bestHauler, carryCapacity, distanceKm, haulerCarry, haulerCount, HAULER_IDS, regionById, unitById } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, matchRegions, matches, playerTechs, players, tradeRoutes } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "./clock.js";
import { projectRegion, stockOf } from "./regions.js";
import { sendArmy, type CommandContext } from "./commands.js";
import type { MatchRow } from "../worker/jobs.js";

export type TradeRouteRow = typeof tradeRoutes.$inferSelect;
type PlayerRow = typeof players.$inferSelect;

const GOODS = ["food", "wood", "stone", "copper", "tin", "iron", "horses"] as const;

/**
 * Trade route dispatcher (worker loop). Every due route loads caravans at its
 * origin and sends them as a transport mission; they unload and walk back.
 */
export async function runTradeRoutes(db: Db, publisher: Publisher, log: pino.Logger): Promise<number> {
  const due = await db
    .select({ route: tradeRoutes, m: matches })
    .from(tradeRoutes)
    .innerJoin(matches, eq(matches.id, tradeRoutes.matchId))
    .where(and(eq(matches.status, "running"), isNull(matches.pausedAt), eq(tradeRoutes.enabled, true), lte(tradeRoutes.nextAt, sql`now() + make_interval(secs => ${matches.clockOffsetSeconds})`)))
    .limit(200);
  let sent = 0;
  for (const { route, m } of due) {
    const now = matchNow(m);
    try {
      const [p] = await db.select().from(players).where(eq(players.id, route.playerId)).limit(1);
      if (!p) continue;
      const result = await dispatchRoute(db, m, p, route, now);
      if (result.startsWith("sent")) {
        sent += 1;
        await publisher.toPlayer(m.id, p.id, "army.sent", { routeId: route.id });
      }
      // A skipped trip (no caravans home, empty stock) retries soon rather than waiting a whole interval.
      const waitHours = result.startsWith("sent") ? route.everyHours : Math.min(route.everyHours, 0.25);
      await db
        .update(tradeRoutes)
        .set({ lastResult: result, lastRunAt: now, nextAt: new Date(now.getTime() + (waitHours * 3600 * 1000) / m.speed) })
        .where(eq(tradeRoutes.id, route.id));
    } catch (err) {
      // A rule refusal (caravans just left, stock just spent) is a normal skipped trip; anything else is logged.
      const refusal = typeof (err as { statusCode?: number }).statusCode === "number" && (err as { statusCode: number }).statusCode < 500;
      if (!refusal) log.warn({ err, routeId: route.id }, "trade route failed");
      await db
        .update(tradeRoutes)
        .set({ lastResult: refusal ? `skipped: ${(err as Error).message}` : `error: ${(err as Error).message}`, lastRunAt: now, nextAt: new Date(now.getTime() + ((refusal ? Math.min(route.everyHours, 0.25) : route.everyHours) * 3600 * 1000) / m.speed) })
        .where(eq(tradeRoutes.id, route.id));
    }
  }
  return sent;
}

/** Load caravans at the origin according to the route and send them. Returns a human-readable result. */
export async function dispatchRoute(db: Db, m: MatchRow, p: PlayerRow, route: TradeRouteRow, now: Date): Promise<string> {
  const [origin] = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, route.fromRegionId)))
    .limit(1);
  if (!origin || origin.ownerPlayerId !== p.id) return "origin region is no longer yours";
  if (origin.frozenAt) return "origin region is frozen";
  // Stock-up routes: what is still owed, and only once the colony is actually ours.
  let owed: Record<string, number> | null = null;
  if (route.target) {
    const [dest] = await db
      .select({ owner: matchRegions.ownerPlayerId })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, route.toRegionId)))
      .limit(1);
    if (dest?.owner !== p.id) {
      const pendingSettle = await db
        .select({ id: armies.id })
        .from(armies)
        .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.targetRegionId, route.toRegionId), eq(armies.mission, "settle"), eq(armies.status, "outbound")))
        .limit(1);
      if (pendingSettle.length === 0) {
        await db.delete(tradeRoutes).where(eq(tradeRoutes.id, route.id));
        return "colony was not founded; stock-up cancelled";
      }
      return "waiting for the settlers to found the colony";
    }
    owed = {};
    for (const [k, v] of Object.entries(route.target)) {
      const left = Math.floor(v - (route.delivered[k] ?? 0));
      if (left >= 1) owed[k] = left;
    }
    if (Object.keys(owed).length === 0) {
      await db.delete(tradeRoutes).where(eq(tradeRoutes.id, route.id));
      return "stock-up complete";
    }
  }
  const kind = bestHauler(origin.units);
  if (!kind) return fetchCaravans(db, m, p, route.fromRegionId, route.caravans, now);
  const home = origin.units[kind] ?? 0;
  const ctx = await contextFor(db, m, p);
  const perCaravan = haulerCarry(kind, ctx.techs);
  const n = Math.min(route.caravans, home);
  const capacity = n * perCaravan;

  const { economy, rates } = projectRegion(origin, now, m.speed);
  const stock = stockOf({ ...origin, food: economy.food, wood: economy.wood, stone: economy.stone, special: economy.special });
  const cargo: Record<string, number> = {};
  if (route.mode === "share") {
    for (const res of ["food", "wood", "stone"] as const) {
      const want = Math.max(0, rates.gross[res] * route.everyHours * route.share);
      const amt = Math.min(want, stock[res] ?? 0);
      if (amt >= 1) cargo[res] = Math.floor(amt);
    }
  } else {
    for (const res of GOODS) {
      const want = owed ? (owed[res] ?? 0) : (route.load[res] ?? 0);
      const amt = Math.min(want, stock[res] ?? 0);
      if (amt >= 1) cargo[res] = Math.floor(amt);
    }
  }
  let total = Object.values(cargo).reduce((a, b) => a + b, 0);
  if (total < 1) return "nothing to send (stock empty)";
  if (total > capacity) {
    const f = capacity / total;
    for (const k of Object.keys(cargo)) cargo[k] = Math.floor(cargo[k]! * f);
    total = Object.values(cargo).reduce((a, b) => a + b, 0);
  }
  const caravans = Math.max(1, Math.min(n, Math.ceil(total / perCaravan)));
  if (carryCapacity({ [kind]: caravans }, ctx.techs) < total) return "haulers cannot carry that much";
  const kindName = (unitById.get(kind)?.name ?? kind).toLowerCase();

  await sendArmy(ctx, route.fromRegionId, { mission: "transport", targetRegionId: route.toRegionId, units: { [kind]: caravans }, people: 0, cargo });
  const desc = Object.entries(cargo)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  if (owed) {
    const delivered = { ...route.delivered };
    for (const [k, v] of Object.entries(cargo)) delivered[k] = (delivered[k] ?? 0) + v;
    const done = Object.entries(route.target!).every(([k, v]) => (delivered[k] ?? 0) >= v - 0.5);
    if (done) {
      await db.delete(tradeRoutes).where(eq(tradeRoutes.id, route.id));
      return `sent ${caravans} ${kindName}${caravans === 1 ? "" : "s"} with ${desc}; stock-up complete`;
    }
    await db.update(tradeRoutes).set({ delivered }).where(eq(tradeRoutes.id, route.id));
  }
  return `sent ${caravans} ${kindName}${caravans === 1 ? "" : "s"} with ${desc}`;
}

async function contextFor(db: Db, m: MatchRow, p: PlayerRow): Promise<CommandContext> {
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
  return { db, m, p, techs: new Set(techRows.map((t) => t.id)) };
}

/**
 * No caravans at the route's origin: bring idle ones over from the nearest
 * other region of mine, first come first served: no caravan is reserved for
 * any route, so whichever route is due first gets the nearest idle ones.
 * Only one relief convoy is on the road to an origin at a time.
 */
async function fetchCaravans(db: Db, m: MatchRow, p: PlayerRow, fromRegionId: string, wanted: number, now: Date): Promise<string> {
  if (!balance.trade.fetchCaravans) return "no haulers at home (they may be on the road)";
  const coming = await db
    .select({ id: armies.id, units: armies.units, origin: armies.originRegionId })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "move"), eq(armies.status, "outbound"), eq(armies.targetRegionId, fromRegionId)));
  const relief = coming.find((a) => haulerCount(a.units) > 0);
  if (relief) return `no haulers at home; ${haulerCount(relief.units)} coming from ${regionNameOf(relief.origin)}`;
  const mine = await db
    .select({ regionId: matchRegions.regionId, units: matchRegions.units, frozenAt: matchRegions.frozenAt })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id)));
  // First come, first served: any hauler standing idle anywhere is fair game; the biggest kind goes first.
  const spareOf = (r: { units: Record<string, number> }) => haulerCount(r.units);
  const candidates = mine
    .filter((r) => r.regionId !== fromRegionId && !r.frozenAt && spareOf(r) > 0)
    .sort((a, b) => distanceKm(a.regionId, fromRegionId) - distanceKm(b.regionId, fromRegionId));
  const source = candidates[0];
  if (!source) return "no haulers at home, and none idle elsewhere";
  const going: Record<string, number> = {};
  let left = wanted;
  for (const id of HAULER_IDS) {
    const take = Math.min(left, source.units[id] ?? 0);
    if (take > 0) going[id] = take;
    left -= take;
    if (left <= 0) break;
  }
  const n = Object.values(going).reduce((a, b) => a + b, 0);
  const ctx = await contextFor(db, m, p);
  const r = await sendArmy(ctx, source.regionId, { mission: "move", targetRegionId: fromRegionId, units: going, people: 0, cargo: {} });
  const hours = ((r.army.arrivesAt.getTime() - now.getTime()) / 3_600_000) * m.speed;
  return `no haulers at home; ${n} coming from ${regionNameOf(source.regionId)}, about ${hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${hours.toFixed(1)} h`}`;
}

function regionNameOf(id: string): string {
  return regionById(id)?.name ?? id;
}

/**
 * Overflow to the capital: a region whose food, wood or stone has reached its
 * storage cap sends a quarter of that cap to the owner's capital by caravan.
 * One overflow convoy per region at a time; idle caravans are fetched from
 * elsewhere when the region has none.
 */
export async function runOverflow(db: Db, publisher: Publisher, log: pino.Logger): Promise<number> {
  if (!balance.trade.overflowToCapital) return 0;
  const running = await db.select().from(matches).where(and(eq(matches.status, "running"), isNull(matches.pausedAt)));
  let sent = 0;
  for (const m of running) {
    const now = matchNow(m);
    const ps = await db.select().from(players).where(and(eq(players.matchId, m.id), sql`${players.capitalRegionId} is not null`, sql`${players.eliminatedAt} is null`));
    const rows = await db
      .select()
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), sql`${matchRegions.ownerPlayerId} is not null`, eq(matchRegions.isCapital, false), sql`${matchRegions.frozenAt} is null`));
    const outbound = await db
      .select({ origin: armies.originRegionId })
      .from(armies)
      .where(and(eq(armies.matchId, m.id), eq(armies.mission, "transport"), eq(armies.status, "outbound")));
    const busy = new Set(outbound.map((a) => a.origin));
    for (const p of ps) {
      const capital = p.capitalRegionId!;
      const capRow = rows.find((r) => r.regionId === capital);
      // The capital row is excluded above (isCapital), so look it up directly to make sure it is still theirs and thawed.
      const [cap] = capRow ? [capRow] : await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, capital))).limit(1);
      if (!cap || cap.ownerPlayerId !== p.id || cap.frozenAt) continue;
      let ctx: CommandContext | null = null;
      for (const row of rows) {
        if (row.ownerPlayerId !== p.id || busy.has(row.regionId)) continue;
        const { economy } = projectRegion(row, now, m.speed);
        const cargo: Record<string, number> = {};
        for (const res of ["food", "wood", "stone"] as const) {
          if (economy[res] >= economy.storage[res] * 0.98) cargo[res] = Math.floor(economy.storage[res] * balance.trade.overflowShare);
        }
        const total = Object.values(cargo).reduce((a, b) => a + b, 0);
        if (total < 1) continue;
        ctx ??= await contextFor(db, m, p);
        const kind = bestHauler(row.units);
        const per = haulerCarry(kind ?? "caravan", ctx.techs);
        const need = Math.ceil(total / per);
        const home = kind ? (row.units[kind] ?? 0) : 0;
        try {
          if (!kind || home <= 0) {
            const r = await fetchCaravans(db, m, p, row.regionId, need, now);
            if (r.startsWith("no haulers at home;")) busy.add(row.regionId);
            continue;
          }
          const n = Math.min(home, need);
          if (n < need) {
            const f = (n * per) / total;
            for (const k of Object.keys(cargo)) cargo[k] = Math.floor(cargo[k]! * f);
          }
          await sendArmy(ctx, row.regionId, { mission: "transport", targetRegionId: capital, units: { [kind]: n }, people: 0, cargo });
          busy.add(row.regionId);
          sent += 1;
          await publisher.toPlayer(m.id, p.id, "army.sent", { overflowFrom: row.regionId });
        } catch (err) {
          const refusal = typeof (err as { statusCode?: number }).statusCode === "number" && (err as { statusCode: number }).statusCode < 500;
          if (!refusal) log.warn({ err, regionId: row.regionId }, "overflow dispatch failed");
        }
      }
    }
  }
  return sent;
}
