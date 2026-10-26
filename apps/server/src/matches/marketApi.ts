import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type pino from "pino";
import { acceptOrderBody, balance, createOrderBody, effectsOf, storageCaps, type MarketOrderView, type MarketResponse, type TradeResource, RESOURCE_WORTH, MARKET_MAX_RATIO } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import type { MatchRow } from "../worker/jobs.js";
import type { PlayerRow } from "../sim/commands.js";
import { marketOrders, matchRegions, matches, messages, players, transfers } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { recordSpend } from "../sim/ledger.js";
import { httpError } from "../sim/commands.js";
import { applyCost, settleAndLockRegion, stockOf, type MatchRegionRow, type Tx, resourceMultOf } from "../sim/regions.js";
import { idParams, orderParams } from "./params.js";
import { enterMap, mapOf } from "../map/scope.js";

const MAX_OPEN_ORDERS = 10;

type OrderRow = typeof marketOrders.$inferSelect;

/** Storage cap for one resource in a region. */
function capFor(row: MatchRegionRow, res: TradeResource): number {
  if (res === "food" || res === "wood" || res === "stone") return storageCaps(effectsOf(row.buildings), row.isCapital)[res];
  return balance.economy.specialStorage;
}

/** Credit `amount` of `res` into a settled, locked row, capped at storage. Returns what was actually credited. */
async function credit(tx: Tx, row: MatchRegionRow, res: TradeResource, amount: number): Promise<number> {
  const room = Math.max(0, capFor(row, res) - (stockOf(row)[res] ?? 0));
  const credited = Math.min(amount, room);
  if (credited > 0) await applyCost(tx, row, { [res]: credited }, -1);
  return credited;
}

/** A basic player-to-player market: post an offer (escrowed), accept it, or cancel it. */
async function lockOrder(tx: Tx, matchId: string, orderId: string): Promise<OrderRow> {
  const rows = await tx
    .select()
    .from(marketOrders)
    .where(and(eq(marketOrders.matchId, matchId), eq(marketOrders.id, orderId)))
    .for("update");
  const o = rows[0];
  if (!o) throw httpError(404, "order not found");
  return o;
}

async function notify(tx: Tx, matchId: string, playerId: string, subject: string, payload: Record<string, unknown>) {
  await tx.insert(messages).values({ matchId, playerId, kind: "trade", subject, payload });
}

export async function marketRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  async function loadContext(matchId: string, userId: string, mustRun = true) {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (mustRun && m.status !== "running") throw httpError(409, "the match is not running");
    if (mustRun && m.pausedAt) throw httpError(409, "the match is paused");
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
      .limit(1);
    if (!p) throw httpError(403, "not your match");
    return { m, p };
  }


  function toView(o: OrderRow, name: string, viewerPlayerId?: string): MarketOrderView {
    return {
      id: o.id,
      playerId: o.playerId,
      playerName: name,
      regionId: viewerPlayerId && o.playerId === viewerPlayerId ? o.regionId : null,
      boughtByMe: !!viewerPlayerId && o.filledByPlayerId === viewerPlayerId && o.playerId !== viewerPlayerId,
      acceptedAt: o.acceptedAt?.toISOString() ?? null,
      offerResource: o.offerResource as TradeResource,
      offerAmount: o.offerAmount,
      askResource: o.askResource as TradeResource,
      askAmount: o.askAmount,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    };
  }

  app.get("/api/matches/:id/market", async (req): Promise<MarketResponse> => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const { p } = await loadContext(matchId, user.id, false);
    const open = await db
      .select()
      .from(marketOrders)
      .where(and(eq(marketOrders.matchId, matchId), eq(marketOrders.status, "open")))
      .orderBy(desc(marketOrders.createdAt))
      .limit(200);
    const mine = await db
      .select()
      .from(marketOrders)
      // My offers, and purchases of mine still waiting on my capital's payment.
      .where(and(eq(marketOrders.matchId, matchId), or(and(eq(marketOrders.playerId, p.id), inArray(marketOrders.status, ["open", "pending", "filled"])), and(eq(marketOrders.filledByPlayerId, p.id), eq(marketOrders.status, "pending")))))
      .orderBy(desc(marketOrders.createdAt))
      .limit(50);
    const ids = [...new Set([...open, ...mine].map((o) => o.playerId))];
    const names = new Map(ids.length ? (await db.select({ id: players.id, name: players.name }).from(players).where(inArray(players.id, ids))).map((r) => [r.id, r.name]) : []);
    return {
      open: open.map((o) => toView(o, names.get(o.playerId) ?? "Unknown")),
      mine: mine.map((o) => toView(o, names.get(o.playerId) ?? "Unknown", p.id)),
    };
  });

  app.post("/api/matches/:id/market", async (req, reply) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const body = createOrderBody.parse(req.body);
    const { m, p } = await loadContext(matchId, user.id);
    const order = await createMarketOrder(db, m, p, body);
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: order.regionId });
    await publisher.toMatch(matchId, "trade.filled", { orderId: order.id, action: "posted" });
    return reply.code(201).send(toView(order, p.name, p.id));
  });

  app.post("/api/matches/:id/market/:orderId/cancel", async (req) => {
    const user = requireUser(req);
    const { id: matchId, orderId } = orderParams.parse(req.params);
    const { m, p } = await loadContext(matchId, user.id);
    const refundedTo = await cancelMarketOrder(db, m, p, orderId);
    if (refundedTo) await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: refundedTo });
    await publisher.toMatch(matchId, "trade.filled", { orderId, action: "cancelled" });
    return { ok: true, refundedTo };
  });

  app.post("/api/matches/:id/market/:orderId/accept", async (req) => {
    const user = requireUser(req);
    const { id: matchId, orderId } = orderParams.parse(req.params);
    acceptOrderBody.parse(req.body ?? {});
    const { m, p } = await loadContext(matchId, user.id);

    // Paid from and delivered to the capital. A short capital does not stop the purchase: it goes through once it can pay.
    const result = await acceptMarketOrder(db, m, p, orderId, { mayWait: true });

    if (result.buyerRegionId) await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: result.buyerRegionId });
    if (result.sellerRegionId) await publisher.toPlayer(matchId, result.sellerId, "region.updated", { regionId: result.sellerRegionId });
    for (const id of [p.id, result.sellerId]) {
      await publisher.toPlayer(matchId, id, "trade.filled", { orderId, action: result.pending ? "pending" : "filled" });
      await publisher.toPlayer(matchId, id, "message.new", {});
    }
    return { ok: true, received: result.received, pending: result.pending };
  });
}

/** The player's capital, which every market trade is paid from and delivered to. */
function capitalIdOf(p: PlayerRow): string {
  if (!p.capitalRegionId) throw httpError(409, "you have no capital to trade from");
  return p.capitalRegionId;
}

/** Post an offer: the goods are escrowed from the capital at once. At most MAX_OPEN_ORDERS open per player, within MARKET_MAX_RATIO of fair. */
export async function createMarketOrder(db: Db, m: MatchRow, p: PlayerRow, body: { offerResource: TradeResource; offerAmount: number; askResource: TradeResource; askAmount: number }, byAdvisor = false): Promise<OrderRow> {
  const matchId = m.id;
  if (body.offerResource === body.askResource) throw httpError(400, "offer and ask must differ");
  // A gift dressed as a trade is how alts feed a main account: both sides must be within reason of each other.
  const offerWorth = body.offerAmount * (RESOURCE_WORTH[body.offerResource] ?? 1);
  const askWorth = body.askAmount * (RESOURCE_WORTH[body.askResource] ?? 1);
  if (offerWorth > askWorth * MARKET_MAX_RATIO || askWorth > offerWorth * MARKET_MAX_RATIO) throw httpError(400, `that price is too far from fair to be a trade (more than ${MARKET_MAX_RATIO}x either way)`);
  const capitalId = capitalIdOf(p);
  return db.transaction(async (tx) => {
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(marketOrders)
      .where(and(eq(marketOrders.playerId, p.id), eq(marketOrders.status, "open")));
    if ((count?.n ?? 0) >= MAX_OPEN_ORDERS) throw httpError(409, `you already have ${MAX_OPEN_ORDERS} open orders`);
    const row = await settleAndLockRegion(tx, matchId, capitalId, matchNow(m), m.speed, resourceMultOf(m));
    if (row.ownerPlayerId !== p.id) throw httpError(409, "you have no capital to trade from");
    if (row.frozenAt) throw httpError(409, "your capital is frozen");
    if ((stockOf(row)[body.offerResource] ?? 0) < body.offerAmount) throw httpError(409, `not enough ${body.offerResource} in your capital`);
    await applyCost(tx, row, { [body.offerResource]: body.offerAmount });
    await recordSpend(tx, m, p.id, "market", { [body.offerResource]: body.offerAmount });
    const [o] = await tx
      .insert(marketOrders)
      .values({
        matchId,
        playerId: p.id,
        regionId: capitalId,
        offerResource: body.offerResource,
        offerAmount: body.offerAmount,
        askResource: body.askResource,
        askAmount: body.askAmount,
        status: "open",
        placedByAdvisor: byAdvisor,
      })
      .returning();
    if (!o) throw new Error("order insert failed");
    return o;
  });
}

/**
 * Withdraw an offer. The seller takes back an open offer: the goods go back to the capital (or the order's region if
 * the player has no capital), capped at storage. A buyer whose purchase is still waiting on payment backs out of it
 * instead, and the offer goes back on the market. Returns where refunded goods went.
 */
export async function cancelMarketOrder(db: Db, m: MatchRow, p: PlayerRow, orderId: string): Promise<string | null> {
  const matchId = m.id;
  const now = matchNow(m);
  return db.transaction(async (tx) => {
    const o = await lockOrder(tx, matchId, orderId);
    if (o.status === "pending" && o.filledByPlayerId === p.id) {
      await tx.update(marketOrders).set({ status: "open", filledByPlayerId: null, acceptedAt: null, filledByAdvisor: false }).where(eq(marketOrders.id, o.id));
      return null;
    }
    if (o.playerId !== p.id) throw httpError(403, "not your order");
    if (o.status === "pending") throw httpError(409, "that offer is sold and waiting on the buyer's payment");
    if (o.status !== "open") throw httpError(409, "that order is no longer open");
    const res = o.offerResource as TradeResource;
    let dest: MatchRegionRow | null = null;
    for (const id of [...new Set([p.capitalRegionId, o.regionId].filter((x): x is string => !!x))]) {
      const row = await settleAndLockRegion(tx, matchId, id, now, m.speed, resourceMultOf(m));
      if (row.ownerPlayerId === p.id) {
        dest = row;
        break;
      }
    }
    if (dest) {
      await credit(tx, dest, res, o.offerAmount);
      await recordSpend(tx, m, p.id, "market", { [res]: o.offerAmount }, -1);
    }
    await tx.update(marketOrders).set({ status: "cancelled" }).where(eq(marketOrders.id, o.id));
    return dest?.regionId ?? null;
  });
}

/**
 * Pay for a sold order out of the buyer's capital and deliver both sides, capital to capital, if the buyer's capital
 * can pay now. The order is locked by the caller's transaction. Returns null when the capital is short.
 */
async function settleOrder(tx: Tx, m: MatchRow, o: OrderRow, buyer: PlayerRow, byAdvisor: boolean) {
  const now = matchNow(m);
  const [seller] = await tx.select().from(players).where(eq(players.id, o.playerId)).limit(1);
  if (!seller) throw httpError(404, "seller not found");
  const offerRes = o.offerResource as TradeResource;
  const askRes = o.askResource as TradeResource;
  const buyerCap = capitalIdOf(buyer);
  // Lock both capitals in ascending id order.
  const ids = [...new Set([buyerCap, ...(seller.capitalRegionId ? [seller.capitalRegionId] : [])])].sort();
  const locked = new Map<string, MatchRegionRow>();
  for (const id of ids) locked.set(id, await settleAndLockRegion(tx, m.id, id, now, m.speed, resourceMultOf(m)));
  const buyerRow = locked.get(buyerCap)!;
  if (buyerRow.ownerPlayerId !== buyer.id) throw httpError(409, "you have no capital to trade from");
  if (buyerRow.frozenAt || (stockOf(buyerRow)[askRes] ?? 0) < o.askAmount) return null;

  const paid = await applyCost(tx, buyerRow, { [askRes]: o.askAmount });
  await recordSpend(tx, m, buyer.id, "market", { [askRes]: o.askAmount });
  const received = await credit(tx, paid, offerRes, o.offerAmount);
  let sellerRow = seller.capitalRegionId && seller.capitalRegionId !== buyerCap ? (locked.get(seller.capitalRegionId) ?? null) : null;
  if (sellerRow && sellerRow.ownerPlayerId !== seller.id) sellerRow = null;
  const sellerGot = sellerRow ? await credit(tx, sellerRow, askRes, o.askAmount) : 0;

  await tx.update(marketOrders).set({ status: "filled", filledByPlayerId: buyer.id, filledAt: now, filledByAdvisor: byAdvisor }).where(eq(marketOrders.id, o.id));
  await tx.insert(transfers).values([
    { matchId: m.id, fromPlayerId: seller.id, toPlayerId: buyer.id, resource: offerRes, amount: o.offerAmount, via: "trade" },
    { matchId: m.id, fromPlayerId: buyer.id, toPlayerId: seller.id, resource: askRes, amount: o.askAmount, via: "trade" },
  ]);
  const summary = { orderId: o.id, offerResource: offerRes, offerAmount: o.offerAmount, askResource: askRes, askAmount: o.askAmount };
  await notify(tx, m.id, seller.id, `${buyer.name} bought your ${Math.round(o.offerAmount)} ${offerRes} for ${Math.round(o.askAmount)} ${askRes}`, {
    ...summary,
    buyer: buyer.name,
    received: sellerGot,
    regionId: sellerRow?.regionId ?? null,
  });
  await notify(tx, m.id, buyer.id, `You bought ${Math.round(o.offerAmount)} ${offerRes} from ${seller.name} for ${Math.round(o.askAmount)} ${askRes}`, {
    ...summary,
    seller: seller.name,
    received,
    regionId: buyerCap,
  });
  return { sellerId: seller.id, sellerRegionId: sellerRow?.regionId ?? null, buyerRegionId: buyerCap as string | null, received, sellerGot };
}

/**
 * Accept an open order. The buyer's capital pays the ask and receives the offer; the seller is paid at their capital.
 * When the capital is short and `mayWait` is set, the order is taken off the market as the buyer's and settled as soon
 * as the capital can pay (see settlePendingOrders); otherwise a short capital is refused.
 */
export async function acceptMarketOrder(db: Db, m: MatchRow, p: PlayerRow, orderId: string, opts: { byAdvisor?: boolean; mayWait?: boolean } = {}) {
  const now = matchNow(m);
  return db.transaction(async (tx) => {
    const o = await lockOrder(tx, m.id, orderId);
    if (o.status !== "open") throw httpError(409, "that order is no longer open");
    if (o.playerId === p.id) throw httpError(400, "you cannot accept your own order");
    const done = await settleOrder(tx, m, o, p, opts.byAdvisor ?? false);
    if (done) return { ...done, pending: false };
    if (!opts.mayWait) throw httpError(409, `not enough ${o.askResource} in your capital`);
    await tx.update(marketOrders).set({ status: "pending", filledByPlayerId: p.id, acceptedAt: now, filledByAdvisor: opts.byAdvisor ?? false }).where(eq(marketOrders.id, o.id));
    const hours = balance.market.payWithinHours;
    await notify(tx, m.id, p.id, `You bought ${Math.round(o.offerAmount)} ${o.offerResource} for ${Math.round(o.askAmount)} ${o.askResource}, to be paid when your capital holds it`, {
      orderId: o.id,
      pending: true,
      text: `The deal is held for you for ${hours} game hours. Once your capital holds ${Math.round(o.askAmount)} ${o.askResource} it is paid and the ${o.offerResource} delivered there.`,
    });
    await notify(tx, m.id, o.playerId, `${p.name} bought your ${Math.round(o.offerAmount)} ${o.offerResource}; you are paid when their capital can pay`, { orderId: o.id, pending: true, buyer: p.name });
    return { sellerId: o.playerId, sellerRegionId: null as string | null, buyerRegionId: null as string | null, received: 0, sellerGot: 0, pending: true };
  });
}

/**
 * Purchases waiting on payment: settled once the buyer's capital holds the price, or put back on the market (and the
 * buyer told) after balance.market.payWithinHours game hours. Run by the worker with the trade routes.
 */
export async function settlePendingOrders(db: Db, publisher: Publisher | null, log?: pino.Logger): Promise<number> {
  const waiting = await db
    .select({ id: marketOrders.id, m: matches })
    .from(marketOrders)
    .innerJoin(matches, eq(matches.id, marketOrders.matchId))
    .where(and(eq(marketOrders.status, "pending"), eq(matches.status, "running"), isNull(matches.pausedAt)))
    .orderBy(asc(marketOrders.acceptedAt))
    .limit(200);
  let settled = 0;
  for (const { id, m } of waiting) {
    enterMap(mapOf(m));
    try {
      const out = await db.transaction(async (tx) => {
        const o = await lockOrder(tx, m.id, id);
        if (o.status !== "pending" || !o.filledByPlayerId) return null;
        const [buyer] = await tx.select().from(players).where(eq(players.id, o.filledByPlayerId)).limit(1);
        const now = matchNow(m);
        const overdue = !!o.acceptedAt && ((now.getTime() - o.acceptedAt.getTime()) * m.speed) / 3_600_000 > balance.market.payWithinHours;
        if (buyer && buyer.capitalRegionId && !buyer.eliminatedAt && !overdue) {
          const done = await settleOrder(tx, m, o, buyer, o.filledByAdvisor);
          return done ? { kind: "filled" as const, buyerId: buyer.id as string | null, ...done } : null;
        }
        await tx.update(marketOrders).set({ status: "open", filledByPlayerId: null, acceptedAt: null, filledByAdvisor: false }).where(eq(marketOrders.id, o.id));
        if (buyer) await notify(tx, m.id, buyer.id, `Your purchase of ${Math.round(o.offerAmount)} ${o.offerResource} lapsed: your capital did not hold ${Math.round(o.askAmount)} ${o.askResource} within ${balance.market.payWithinHours} hours, so the offer is back on the market`, { orderId: o.id });
        return { kind: "lapsed" as const, buyerId: buyer?.id ?? null, sellerId: o.playerId, sellerRegionId: null as string | null, buyerRegionId: null as string | null };
      });
      if (!out) continue;
      if (out.kind === "filled") settled += 1;
      if (!publisher) continue;
      if (out.buyerId && out.buyerRegionId) await publisher.toPlayer(m.id, out.buyerId, "region.updated", { regionId: out.buyerRegionId });
      if (out.sellerRegionId) await publisher.toPlayer(m.id, out.sellerId, "region.updated", { regionId: out.sellerRegionId });
      for (const pid of [out.buyerId, out.sellerId]) {
        if (!pid) continue;
        await publisher.toPlayer(m.id, pid, "trade.filled", { orderId: id, action: out.kind });
        await publisher.toPlayer(m.id, pid, "message.new", {});
      }
    } catch (err) {
      log?.warn({ err, orderId: id }, "pending market order failed");
    }
  }
  return settled;
}
