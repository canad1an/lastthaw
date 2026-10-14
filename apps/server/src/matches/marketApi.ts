import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { acceptOrderBody, balance, createOrderBody, effectsOf, storageCaps, type MarketOrderView, type MarketResponse, type TradeResource } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { marketOrders, matchRegions, matches, messages, players, transfers } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { httpError } from "../sim/commands.js";
import { applyCost, settleAndLockRegion, stockOf, type MatchRegionRow, type Tx } from "../sim/regions.js";

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
export async function marketRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  async function loadContext(matchId: string, userId: string, mustRun = true) {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (mustRun && m.status !== "running") throw httpError(409, "the match is not running");
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
      .limit(1);
    if (!p) throw httpError(403, "not your match");
    return { m, p };
  }

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

  /** Owner of a region without locking it; used only to choose which rows to lock. */
  async function ownerOf(tx: Tx, matchId: string, regionId: string): Promise<string | null> {
    const [r] = await tx
      .select({ owner: matchRegions.ownerPlayerId })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId)))
      .limit(1);
    return r?.owner ?? null;
  }

  function toView(o: OrderRow, name: string): MarketOrderView {
    return {
      id: o.id,
      playerId: o.playerId,
      playerName: name,
      regionId: o.regionId,
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
    const matchId = (req.params as { id: string }).id;
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
      .where(and(eq(marketOrders.matchId, matchId), eq(marketOrders.playerId, p.id), inArray(marketOrders.status, ["open", "filled"])))
      .orderBy(desc(marketOrders.createdAt))
      .limit(50);
    const ids = [...new Set([...open, ...mine].map((o) => o.playerId))];
    const names = new Map(ids.length ? (await db.select({ id: players.id, name: players.name }).from(players).where(inArray(players.id, ids))).map((r) => [r.id, r.name]) : []);
    return {
      open: open.map((o) => toView(o, names.get(o.playerId) ?? "Unknown")),
      mine: mine.map((o) => toView(o, names.get(o.playerId) ?? "Unknown")),
    };
  });

  app.post("/api/matches/:id/market", async (req, reply) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const body = createOrderBody.parse(req.body);
    if (body.offerResource === body.askResource) throw httpError(400, "offer and ask must differ");
    const { m, p } = await loadContext(matchId, user.id);

    const order = await db.transaction(async (tx) => {
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(marketOrders)
        .where(and(eq(marketOrders.playerId, p.id), eq(marketOrders.status, "open")));
      if ((count?.n ?? 0) >= MAX_OPEN_ORDERS) throw httpError(409, `you already have ${MAX_OPEN_ORDERS} open orders`);
      const row = await settleAndLockRegion(tx, matchId, body.regionId, matchNow(m), m.speed);
      if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
      if (row.frozenAt) throw httpError(409, "this region is frozen");
      if ((stockOf(row)[body.offerResource] ?? 0) < body.offerAmount) throw httpError(409, `not enough ${body.offerResource}`);
      await applyCost(tx, row, { [body.offerResource]: body.offerAmount });
      const [o] = await tx
        .insert(marketOrders)
        .values({
          matchId,
          playerId: p.id,
          regionId: body.regionId,
          offerResource: body.offerResource,
          offerAmount: body.offerAmount,
          askResource: body.askResource,
          askAmount: body.askAmount,
          status: "open",
        })
        .returning();
      if (!o) throw new Error("order insert failed");
      return o;
    });
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: body.regionId });
    await publisher.toMatch(matchId, "trade.filled", { orderId: order.id, action: "posted" });
    return reply.code(201).send(toView(order, p.name));
  });

  app.post("/api/matches/:id/market/:orderId/cancel", async (req) => {
    const user = requireUser(req);
    const { id: matchId, orderId } = req.params as { id: string; orderId: string };
    const { m, p } = await loadContext(matchId, user.id);
    const now = matchNow(m);

    const refundedTo = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, matchId, orderId);
      if (o.playerId !== p.id) throw httpError(403, "not your order");
      if (o.status !== "open") throw httpError(409, "that order is no longer open");
      const res = o.offerResource as TradeResource;
      let dest: MatchRegionRow | null = await settleAndLockRegion(tx, matchId, o.regionId, now, m.speed);
      if (dest.ownerPlayerId !== p.id) {
        dest = null;
        if (p.capitalRegionId && p.capitalRegionId !== o.regionId) {
          const cap = await settleAndLockRegion(tx, matchId, p.capitalRegionId, now, m.speed);
          if (cap.ownerPlayerId === p.id) dest = cap;
        }
      }
      if (dest) await credit(tx, dest, res, o.offerAmount);
      await tx.update(marketOrders).set({ status: "cancelled" }).where(eq(marketOrders.id, o.id));
      return dest?.regionId ?? null;
    });
    if (refundedTo) await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: refundedTo });
    await publisher.toMatch(matchId, "trade.filled", { orderId, action: "cancelled" });
    return { ok: true, refundedTo };
  });

  app.post("/api/matches/:id/market/:orderId/accept", async (req) => {
    const user = requireUser(req);
    const { id: matchId, orderId } = req.params as { id: string; orderId: string };
    const body = acceptOrderBody.parse(req.body);
    const { m, p } = await loadContext(matchId, user.id);
    const now = matchNow(m);

    const result = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, matchId, orderId);
      if (o.status !== "open") throw httpError(409, "that order is no longer open");
      if (o.playerId === p.id) throw httpError(400, "you cannot accept your own order");
      const [seller] = await tx.select().from(players).where(eq(players.id, o.playerId)).limit(1);
      if (!seller) throw httpError(404, "seller not found");
      const offerRes = o.offerResource as TradeResource;
      const askRes = o.askResource as TradeResource;

      // Decide which seller region receives payment, then lock both regions in ascending id order.
      const sellerDest = (await ownerOf(tx, matchId, o.regionId)) === seller.id ? o.regionId : seller.capitalRegionId;
      if (sellerDest === body.regionId) throw httpError(400, "that region is not yours");
      const ids = [body.regionId, ...(sellerDest ? [sellerDest] : [])].sort();
      const locked = new Map<string, MatchRegionRow>();
      for (const id of ids) locked.set(id, await settleAndLockRegion(tx, matchId, id, now, m.speed));

      const buyerRow = locked.get(body.regionId)!;
      if (buyerRow.ownerPlayerId !== p.id) throw httpError(403, "not your region");
      if (buyerRow.frozenAt) throw httpError(409, "this region is frozen");
      if ((stockOf(buyerRow)[askRes] ?? 0) < o.askAmount) throw httpError(409, `not enough ${askRes}`);

      const paid = await applyCost(tx, buyerRow, { [askRes]: o.askAmount });
      const received = await credit(tx, paid, offerRes, o.offerAmount);

      let sellerRow = sellerDest ? (locked.get(sellerDest) ?? null) : null;
      if (sellerRow && sellerRow.ownerPlayerId !== seller.id) sellerRow = null;
      const sellerGot = sellerRow ? await credit(tx, sellerRow, askRes, o.askAmount) : 0;

      await tx.update(marketOrders).set({ status: "filled", filledByPlayerId: p.id, filledAt: now }).where(eq(marketOrders.id, o.id));
      await tx.insert(transfers).values([
        { matchId, fromPlayerId: seller.id, toPlayerId: p.id, resource: offerRes, amount: o.offerAmount, via: "trade" },
        { matchId, fromPlayerId: p.id, toPlayerId: seller.id, resource: askRes, amount: o.askAmount, via: "trade" },
      ]);
      const summary = { orderId: o.id, offerResource: offerRes, offerAmount: o.offerAmount, askResource: askRes, askAmount: o.askAmount };
      await notify(tx, matchId, seller.id, `${p.name} bought your ${Math.round(o.offerAmount)} ${offerRes} for ${Math.round(o.askAmount)} ${askRes}`, {
        ...summary,
        buyer: p.name,
        received: sellerGot,
        regionId: sellerRow?.regionId ?? null,
      });
      await notify(tx, matchId, p.id, `You bought ${Math.round(o.offerAmount)} ${offerRes} from ${seller.name} for ${Math.round(o.askAmount)} ${askRes}`, {
        ...summary,
        seller: seller.name,
        received,
        regionId: body.regionId,
      });
      return { sellerId: seller.id, sellerRegionId: sellerRow?.regionId ?? null, received, sellerGot };
    });

    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: body.regionId });
    if (result.sellerRegionId) await publisher.toPlayer(matchId, result.sellerId, "region.updated", { regionId: result.sellerRegionId });
    for (const id of [p.id, result.sellerId]) {
      await publisher.toPlayer(matchId, id, "trade.filled", { orderId, action: "filled" });
      await publisher.toPlayer(matchId, id, "message.new", {});
    }
    return { ok: true, received: result.received };
  });
}
