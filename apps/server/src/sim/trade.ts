import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type pino from "pino";
import { balance, bestHauler, carryCapacity, distanceKm, findRoute, haulerCarry, haulerCount, HAULER_IDS, regionById, supplyConvoyCap, unitById } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, matchRegions, matches, playerTechs, players, tradeRoutes } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "./clock.js";
import { projectRegion, stockOf, type MatchRegionRow } from "./regions.js";
import { sendArmy, returnHeld, type CommandContext } from "./commands.js";
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
        if (route.forJobId) {
          await db.transaction((tx) => returnHeld(tx, m, route.toRegionId, [route.id]));
          return "destination is no longer yours; the materials went back on the shelf";
        }
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
  if (route.forJobId) return dispatchSupply(db, m, p, route, origin, owed ?? {}, now);
  const kind = bestHauler(origin.units, regionById(route.fromRegionId)?.seaRoutes.includes(route.toRegionId) ?? false);
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
  } else if (route.forJobId) {
    // A materials route carries what was set aside for it, not what the region happens to hold.
    for (const res of GOODS) {
      const amt = Math.min(owed?.[res] ?? 0, route.held[res] ?? 0);
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
  if (total < 1) return route.forJobId ? "nothing set aside to send" : "nothing to send (stock empty)";
  if (total > capacity) {
    const f = capacity / total;
    for (const k of Object.keys(cargo)) cargo[k] = Math.floor(cargo[k]! * f);
    total = Object.values(cargo).reduce((a, b) => a + b, 0);
  }
  const caravans = Math.max(1, Math.min(n, Math.ceil(total / perCaravan)));
  if (carryCapacity({ [kind]: caravans }, ctx.techs) < total) return "haulers cannot carry that much";
  const kindName = (unitById.get(kind)?.name ?? kind).toLowerCase();

  await sendArmy(ctx, route.fromRegionId, { mission: "transport", targetRegionId: route.toRegionId, units: { [kind]: caravans }, people: 0, cargo, prepaid: !!route.forJobId });
  if (route.forJobId) {
    const held = { ...route.held };
    for (const [k, v] of Object.entries(cargo)) held[k] = Math.max(0, (held[k] ?? 0) - v);
    await db.update(tradeRoutes).set({ held }).where(eq(tradeRoutes.id, route.id));
  }
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

/**
 * A materials route's turn: one convoy leaves its origin with what is set aside there and, while it has room, calls at
 * the other materials routes bound for the same destination, nearest next, loading what each has set aside, then delivers.
 * The goods leave each route's hold the moment they are on the manifest. Haulers come from the pool when none are home.
 */
async function dispatchSupply(db: Db, m: MatchRow, p: PlayerRow, route: TradeRouteRow, origin: MatchRegionRow, owed: Record<string, number>, now: Date): Promise<string> {
  const held = Object.fromEntries(Object.entries(route.held).filter(([, v]) => v >= 1));
  if (Object.keys(held).length === 0) {
    // Nothing waiting here: either everything is already on a convoy, or the route is spent.
    if (Object.keys(owed).length === 0) {
      await db.delete(tradeRoutes).where(eq(tradeRoutes.id, route.id));
      return "stock-up complete";
    }
    return "nothing set aside to send (the rest is on its way)";
  }
  // So many convoys at once would strip the empire of haulers: beyond the cap, the route waits its turn.
  const busy = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "transport"), eq(armies.status, "outbound"), sql`jsonb_array_length(${armies.stops}) > 0`));
  const cap = supplyConvoyCap(await haulerFleet(db, m, p));
  if ((busy[0]?.n ?? 0) >= cap) return `waiting: ${busy[0]!.n} of ${cap} materials convoys are already on the road`;
  const ctx = await contextFor(db, m, p);
  const siblings = (
    await db
      .select()
      .from(tradeRoutes)
      .where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.playerId, p.id), eq(tradeRoutes.toRegionId, route.toRegionId), sql`${tradeRoutes.forJobId} is not null`, sql`${tradeRoutes.id} <> ${route.id}`))
  ).filter((r) => Object.values(r.held).some((v) => v >= 1));
  const groupTotal = [route, ...siblings].reduce((a, r) => a + Object.values(r.held).reduce((x, y) => x + y, 0), 0);
  const kind = bestHauler(origin.units, false);
  if (!kind) {
    // A sibling route with haulers at home, or with haulers on the way, sends the convoy that calls here: no need to pull more.
    if (siblings.length) {
      const ids = siblings.map((r) => r.fromRegionId);
      const rows = await db.select({ regionId: matchRegions.regionId, units: matchRegions.units }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, ids)));
      const staffed = rows.find((r) => bestHauler(r.units, false));
      if (staffed) return `waiting for the convoy from ${regionNameOf(staffed.regionId)}`;
      const coming = await db
        .select({ targetRegionId: armies.targetRegionId })
        .from(armies)
        .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "move"), eq(armies.status, "outbound"), inArray(armies.targetRegionId, ids)));
      if (coming[0]) return `waiting for the convoy from ${regionNameOf(coming[0].targetRegionId)}`;
    }
    const per = haulerCarry("caravan", ctx.techs);
    return fetchCaravans(db, m, p, route.fromRegionId, Math.max(1, Math.min(balance.trade.maxSupplyCaravans, Math.ceil(groupTotal / per))), now);
  }
  const perCaravan = haulerCarry(kind, ctx.techs);
  const home = origin.units[kind] ?? 0;
  const n = Math.max(1, Math.min(home, balance.trade.maxSupplyCaravans, Math.ceil(groupTotal / perCaravan)));
  let room = n * perCaravan;

  // Load here first.
  const cargo: Record<string, number> = {};
  for (const [k, v] of Object.entries(held)) {
    const t = Math.min(v, Math.floor(room));
    if (t >= 1) {
      cargo[k] = t;
      room -= t;
    }
  }
  const stops: Array<{ regionId: string; routeId: string | null; take: Record<string, number>; done?: boolean }> = [{ regionId: route.fromRegionId, routeId: route.id, take: cargo, done: true }];
  const holdUpdates = new Map<string, Record<string, number>>();
  {
    const h = { ...route.held };
    for (const [k, v] of Object.entries(cargo)) h[k] = Math.max(0, (h[k] ?? 0) - v);
    holdUpdates.set(route.id, h);
  }
  // Then the nearest other pickups while there is room, each reachable by land from the last.
  let at = route.fromRegionId;
  const pool = [...siblings];
  const heldTotal = (r: TradeRouteRow) => Object.values(r.held).reduce((x, y) => x + y, 0);
  const minimum = perCaravan * balance.trade.minSupplyPickupShare;
  while (room >= 1 && pool.length && stops.length <= balance.trade.maxConvoyCalls) {
    // Nearest next, but a tiny hold is skipped while a worthwhile one remains anywhere in the pool.
    pool.sort((a, b) => distanceKm(at, a.fromRegionId) - distanceKm(at, b.fromRegionId));
    const worthwhile = pool.some((r) => heldTotal(r) >= minimum);
    const i = worthwhile ? pool.findIndex((r) => heldTotal(r) >= minimum) : 0;
    const next = pool.splice(i, 1)[0]!;
    if (next.fromRegionId === at || !findRoute(at, next.fromRegionId, false)) continue;
    const take: Record<string, number> = {};
    const h = { ...next.held };
    for (const [k, v] of Object.entries(next.held)) {
      const t = Math.min(v, Math.floor(room));
      if (t >= 1) {
        take[k] = t;
        room -= t;
        h[k] = v - t;
      }
    }
    if (Object.keys(take).length === 0) continue;
    stops.push({ regionId: next.fromRegionId, routeId: next.id, take });
    holdUpdates.set(next.id, h);
    at = next.fromRegionId;
  }
  stops.push({ regionId: route.toRegionId, routeId: null, take: {} });
  const firstLeg = stops.find((s) => !s.done)!.regionId;
  await sendArmy(ctx, route.fromRegionId, { mission: "transport", targetRegionId: firstLeg, units: { [kind]: n }, people: 0, cargo, prepaid: true, stops });
  for (const [id, h] of holdUpdates) {
    await db
      .update(tradeRoutes)
      .set({ held: h, lastRunAt: now, lastResult: id === route.id ? undefined : `goods loaded by the convoy from ${regionNameOf(route.fromRegionId)}`, nextAt: new Date(now.getTime() + (route.everyHours * 3600 * 1000) / m.speed) })
      .where(eq(tradeRoutes.id, id));
  }
  const kindName = (unitById.get(kind)?.name ?? kind).toLowerCase();
  const desc = Object.entries(cargo)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  const calls = stops.filter((s) => !s.done && s.routeId).map((s) => regionNameOf(s.regionId));
  return `sent ${n} ${kindName}${n === 1 ? "" : "s"} with ${desc}${calls.length ? `; collecting at ${calls.join(", ")} on the way` : ""}`;
}

/** Every land hauler the player owns, at home or on the road: the convoy cap grows with it. */
async function haulerFleet(db: Db, m: MatchRow, p: PlayerRow): Promise<number> {
  const land = HAULER_IDS.filter((id) => !unitById.get(id)?.naval);
  const home = await db.select({ units: matchRegions.units }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id)));
  const road = await db.select({ units: armies.units }).from(armies).where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), inArray(armies.status, ["outbound", "returning"])));
  return [...home, ...road].reduce((a, r) => a + land.reduce((x, id) => x + (r.units[id] ?? 0), 0), 0);
}

async function contextFor(db: Db, m: MatchRow, p: PlayerRow): Promise<CommandContext> {
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
  return { db, m, p, techs: new Set(techRows.map((t) => t.id)) };
}

/**
 * No haulers at the route's origin: the whole fleet is one pool, and any hauler not needed where it stands is called over.
 * Idle haulers (in a region with no route of its own) go first, nearest first; then the spare ones beyond what a
 * region's own routes claim. Several regions may each send a convoy until enough are on the way; what is already
 * marching here counts. Nothing is ever reserved: whichever route comes due first gets the nearest spare haulers.
 */
async function fetchCaravans(db: Db, m: MatchRow, p: PlayerRow, fromRegionId: string, wanted: number, now: Date): Promise<string> {
  if (!balance.trade.fetchCaravans) return "no haulers at home (they may be on the road)";
  const coming = await db
    .select({ id: armies.id, units: armies.units, origin: armies.originRegionId })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "move"), eq(armies.status, "outbound"), eq(armies.targetRegionId, fromRegionId)));
  const inFlight = coming.reduce((a, x) => a + haulerCount(x.units), 0);
  const firstComing = coming.find((a) => haulerCount(a.units) > 0);
  if (inFlight >= wanted && firstComing) return `no haulers at home; ${inFlight} coming from ${regionNameOf(firstComing.origin)}`;
  let need = wanted - inFlight;
  const reliefOut = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "move"), eq(armies.status, "outbound"), sql`(${armies.cargo}->>'people')::float = 0`));
  if ((reliefOut[0]?.n ?? 0) >= balance.trade.maxReliefMoves) return `no haulers at home; ${reliefOut[0]!.n} relief moves are already on the road, waiting for one to land`;

  const mine = await db
    .select({ regionId: matchRegions.regionId, units: matchRegions.units, frozenAt: matchRegions.frozenAt })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id)));
  // What each region's own routes claim: those haulers stay; anything beyond is spare, and a region with no route at all is idle.
  const claims = await db
    .select({ fromRegionId: tradeRoutes.fromRegionId, caravans: tradeRoutes.caravans })
    .from(tradeRoutes)
    .where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.playerId, p.id), eq(tradeRoutes.enabled, true)));
  const claimed = new Map<string, number>();
  for (const c of claims) claimed.set(c.fromRegionId, (claimed.get(c.fromRegionId) ?? 0) + c.caravans);
  const landHaulers = (r: { units: Record<string, number> }) => HAULER_IDS.filter((id) => !unitById.get(id)?.naval).reduce((a, id) => a + (r.units[id] ?? 0), 0);
  const spareOf = (r: { regionId: string; units: Record<string, number> }) => Math.max(0, landHaulers(r) - (claimed.get(r.regionId) ?? 0));
  const candidates = mine
    .filter((r) => r.regionId !== fromRegionId && !r.frozenAt && spareOf(r) > 0)
    .sort((a, b) => {
      const ia = claimed.has(a.regionId) ? 1 : 0;
      const ib = claimed.has(b.regionId) ? 1 : 0;
      return ia - ib || distanceKm(a.regionId, fromRegionId) - distanceKm(b.regionId, fromRegionId);
    });
  if (candidates.length === 0) return inFlight > 0 && firstComing ? `no haulers at home; ${inFlight} coming from ${regionNameOf(firstComing.origin)}` : "no haulers at home, and none spare anywhere: train more";

  const ctx = await contextFor(db, m, p);
  const sent: string[] = [];
  let soonest = Infinity;
  for (const source of candidates) {
    if (need <= 0) break;
    const going: Record<string, number> = {};
    let left = Math.min(need, spareOf(source));
    // The biggest kind goes first.
    for (const id of HAULER_IDS) {
      if (unitById.get(id)?.naval) continue;
      const take = Math.min(left, source.units[id] ?? 0);
      if (take > 0) going[id] = take;
      left -= take;
      if (left <= 0) break;
    }
    const n = Object.values(going).reduce((a, b) => a + b, 0);
    if (n <= 0) continue;
    try {
      const r = await sendArmy(ctx, source.regionId, { mission: "move", targetRegionId: fromRegionId, units: going, people: 0, cargo: {} });
      const hours = ((r.army.arrivesAt.getTime() - now.getTime()) / 3_600_000) * m.speed;
      soonest = Math.min(soonest, hours);
      sent.push(`${n} from ${regionNameOf(source.regionId)}`);
      need -= n;
    } catch {
      // No route from there (sea without ships, say): try the next.
    }
  }
  if (sent.length === 0) return inFlight > 0 && firstComing ? `no haulers at home; ${inFlight} coming from ${regionNameOf(firstComing.origin)}` : "no haulers at home, and none spare can reach here";
  const when = soonest < 1 ? `${Math.max(1, Math.round(soonest * 60))} min` : `${soonest.toFixed(1)} h`;
  return `no haulers at home; ${sent.join(", ")} coming, first in about ${when}`;
}

function regionNameOf(id: string): string {
  return regionById(id)?.name ?? id;
}

/**
 * Overflow to the capital: a region whose food, wood or stone has reached its
 * storage cap sends `overflowShare` of that cap to the owner's capital by caravan.
 * One overflow convoy per region at a time and at most one every `overflowEveryHours`;
 * idle caravans are fetched from elsewhere when the region has none.
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
    // One convoy out at a time, and none within `overflowEveryHours` of the last: a few big loads, not a stream of small ones.
    const recentCutoff = new Date(now.getTime() - (balance.trade.overflowEveryHours * 3600_000) / m.speed);
    const outbound = await db
      .select({ origin: armies.originRegionId })
      .from(armies)
      .where(and(eq(armies.matchId, m.id), eq(armies.mission, "transport"), sql`(${armies.status} = 'outbound' or ${armies.departsAt} > ${recentCutoff.toISOString()}::timestamptz)`));
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
        const kind = bestHauler(row.units, regionById(row.regionId)?.seaRoutes.includes(capital) ?? false);
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
