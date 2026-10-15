import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { balance, colonizeBody, findRoute, sendArmyBody, travelSeconds, setCapitalBody, regionById, convertBody, rallyBody, unitById } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, jobs, matchRegions, matches, playerTechs, players, tradeRoutes } from "../db/schema.js";
import { matchNow } from "../sim/clock.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { httpError, sendArmy, type CommandContext, convertUnits } from "../sim/commands.js";
import { disbandUnits, evacuateRegion } from "../sim/evacuate.js";
import { applyCost, waySetsFor, settleAndLockRegion, stockOf } from "../sim/regions.js";
import { alliesOf } from "../sim/alliances.js";
import { z } from "zod";

export async function armyRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  async function loadContext(matchId: string, userId: string): Promise<CommandContext> {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (m.status !== "running") throw httpError(409, "the match is not running");
    if (m.pausedAt) throw httpError(409, "the match is paused");
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
      .limit(1);
    if (!p) throw httpError(403, "not your match");
    const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
    return { db, m, p, techs: new Set(techRows.map((t) => t.id)) };
  }

  /** Preview travel time without committing anything. */
  app.get("/api/matches/:id/route", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const q = req.query as { from?: string; to?: string; speed?: string };
    if (!q.from || !q.to) throw httpError(400, "from and to are required");
    const { m, p, techs } = await loadContext(matchId, user.id);
    const { roads, rails, harbors } = await waySetsFor(db, m.id, p.id, await alliesOf(db, m.id, p.id));
    const route = findRoute(q.from, q.to, techs.has(balance.travel.seaTech), roads, rails, harbors);
    if (!route) throw httpError(400, techs.has(balance.travel.seaTech) ? "no route" : "no land route; Shipbuilding allows sea crossings");
    const speed = Number(q.speed ?? 5) || 5;
    return { path: route.path, seconds: travelSeconds(route, speed, m.speed), usesSea: route.usesSea };
  });

  /** Evacuate a region: everyone and every unit moves to another of your regions with as much stock as they can carry. */
  app.post("/api/matches/:id/regions/:regionId/evacuate", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const { toRegionId } = z.object({ toRegionId: z.string() }).parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const r = await evacuateRegion(ctx, regionId, toRegionId);
    await publisher.toPlayer(matchId, ctx.p.id, "army.sent", { armyId: r.army.id, evacuated: regionId });
    return { ok: true, armyId: r.army.id, arrivesAt: r.army.arrivesAt.toISOString(), people: r.people, units: r.units, cargo: r.cargo, leftBehind: r.leftBehind };
  });

  /**
   * Colonize an empty region with settlers from this region. With `stock`, a
   * temporary caravan route is created that delivers those totals once the
   * colony is founded, then removes itself. Needs caravans at the source.
   */
  app.post("/api/matches/:id/regions/:regionId/colonize", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const body = colonizeBody.parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const stock = Object.fromEntries(Object.entries(body.stock ?? {}).filter(([, v]) => v >= 1).map(([k, v]) => [k, Math.floor(v)]));
    const wantsStock = Object.keys(stock).length > 0;
    // No hauler needs to be here: the route calls idle ones over from the nearest region when it runs.
    const r = await sendArmy(ctx, regionId, { mission: "settle", targetRegionId: body.targetRegionId, units: { settler: body.settlers }, people: 0, cargo: {} });
    let routeId: string | null = null;
    if (wantsStock) {
      const [route] = await db
        .insert(tradeRoutes)
        .values({
          matchId,
          playerId: ctx.p.id,
          fromRegionId: regionId,
          toRegionId: body.targetRegionId,
          mode: "fixed",
          load: stock,
          share: 0,
          caravans: body.caravans,
          everyHours: 1,
          target: stock,
          delivered: {},
          nextAt: r.army.arrivesAt,
        })
        .returning({ id: tradeRoutes.id });
      routeId = route!.id;
    }
    await publisher.toPlayer(matchId, ctx.p.id, "army.sent", { armyId: r.army.id });
    return { ok: true, armyId: r.army.id, arrivesAt: r.army.arrivesAt.toISOString(), routeId };
  });

  /**
   * Move the capital: a slow capital wagon leaves the old capital carrying as
   * much of its stores as it can. The capital changes when it arrives, and
   * every idle caravan then gathers at the new capital.
   */
  app.post("/api/matches/:id/capital", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const { regionId } = setCapitalBody.parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const { m, p, techs } = ctx;
    if (!p.capitalRegionId) throw httpError(409, "you have no capital");
    if (p.capitalRegionId === regionId) throw httpError(409, "this is already your capital");
    const inFlight = await db
      .select({ id: armies.id, target: armies.targetRegionId, arrivesAt: armies.arrivesAt })
      .from(armies)
      .where(and(eq(armies.matchId, matchId), eq(armies.playerId, p.id), eq(armies.mission, "relocate"), eq(armies.status, "outbound")))
      .limit(1);
    if (inFlight[0]) throw httpError(409, `the capital wagon is already on its way to ${regionById(inFlight[0].target)?.name ?? "another region"}`);
    const { roads, rails, harbors } = await waySetsFor(db, matchId, p.id, await alliesOf(db, matchId, p.id));
    const route = findRoute(p.capitalRegionId, regionId, techs.has(balance.travel.seaTech), roads, rails, harbors);
    if (!route) throw httpError(400, "no route for the wagon");
    const now = matchNow(m);
    const seconds = travelSeconds(route, balance.capital.wagonSpeed, m.speed);
    const result = await db.transaction(async (tx) => {
      const ids = [p.capitalRegionId!, regionId].sort();
      const locked = new Map<string, Awaited<ReturnType<typeof settleAndLockRegion>>>();
      for (const id of ids) locked.set(id, await settleAndLockRegion(tx, matchId, id, now, m.speed));
      const target = locked.get(regionId)!;
      const old = locked.get(p.capitalRegionId!)!;
      if (target.ownerPlayerId !== p.id) throw httpError(403, "not your region");
      if (target.frozenAt) throw httpError(409, "a frozen region cannot be the capital");
      if (old.ownerPlayerId !== p.id) throw httpError(409, "you have lost your capital");
      // Load the wagon: food, wood, stone, then ore and horses, up to its capacity.
      const stock = stockOf(old);
      const cargo: Record<string, number> = {};
      let left = balance.capital.wagonCarry;
      for (const k of ["food", "wood", "stone", ...Object.keys(stock).filter((x) => !["food", "wood", "stone"].includes(x))]) {
        const take = Math.floor(Math.min(stock[k] ?? 0, left));
        if (take >= 1) {
          cargo[k] = take;
          left -= take;
        }
        if (left <= 0) break;
      }
      if (Object.keys(cargo).length) await applyCost(tx, old, cargo);
      const arrivesAt = new Date(now.getTime() + seconds * 1000);
      const [a] = await tx
        .insert(armies)
        .values({ matchId, playerId: p.id, mission: "relocate", originRegionId: p.capitalRegionId!, targetRegionId: regionId, units: {}, cargo, path: route.path, status: "outbound", departsAt: now, arrivesAt })
        .returning();
      await tx.insert(jobs).values({ matchId, playerId: p.id, regionId, kind: "mission", refId: a!.id, startsAt: now, endsAt: arrivesAt });
      return { armyId: a!.id, arrivesAt, cargo };
    });
    await publisher.toPlayer(matchId, p.id, "army.sent", { armyId: result.armyId, relocate: regionId });
    return { ok: true, armyId: result.armyId, arrivesAt: result.arrivesAt.toISOString(), cargo: result.cargo, path: route.path };
  });

  /** Upgrade haulers in a region (caravans to wagons, caravans or wagons to trains). */
  app.post("/api/matches/:id/regions/:regionId/convert", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const body = convertBody.parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const r = await convertUnits(ctx, regionId, body.from, body.to, body.qty);
    await publisher.toPlayer(matchId, ctx.p.id, "region.updated", { regionId });
    return { ok: true, converted: r.converted, cost: r.cost };
  });

  /** Disband stationed units: they rejoin the region's workers. */
  app.post("/api/matches/:id/regions/:regionId/disband", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const { units } = z.object({ units: z.record(z.string(), z.number().int().min(0)) }).parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const r = await disbandUnits(ctx, regionId, units);
    await publisher.toPlayer(matchId, ctx.p.id, "region.updated", { regionId });
    return { ok: true, disbanded: r.disbanded };
  });

  /**
   * Rally to the capital: stationed soldiers in every other region march there.
   * With includeMissions, outbound armies are recalled as well (they return to
   * the region they left from; rally again once they are home).
   */
  app.post("/api/matches/:id/rally", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const { includeMissions } = rallyBody.parse(req.body ?? {});
    const ctx = await loadContext(matchId, user.id);
    const { m, p } = ctx;
    if (!p.capitalRegionId) throw httpError(409, "you have no capital");
    const rows = await db
      .select({ regionId: matchRegions.regionId, units: matchRegions.units, frozenAt: matchRegions.frozenAt })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.ownerPlayerId, p.id)));
    let groups = 0;
    let soldiers = 0;
    const skipped: string[] = [];
    for (const r of rows) {
      if (r.regionId === p.capitalRegionId || r.frozenAt) continue;
      const units: Record<string, number> = {};
      for (const [id, n] of Object.entries(r.units)) if (n > 0 && !unitById.get(id)?.civilian && !unitById.get(id)?.naval) units[id] = n;
      const n = Object.values(units).reduce((a, b) => a + b, 0);
      if (n === 0) continue;
      try {
        await sendArmy(ctx, r.regionId, { mission: "move", targetRegionId: p.capitalRegionId, units, people: 0, cargo: {} });
        groups += 1;
        soldiers += n;
      } catch (err) {
        skipped.push(`${regionById(r.regionId)?.name ?? r.regionId}: ${(err as Error).message}`);
      }
    }
    let recalled = 0;
    if (includeMissions) {
      const now = matchNow(m);
      const out = await db
        .select()
        .from(armies)
        .where(and(eq(armies.matchId, matchId), eq(armies.playerId, p.id), eq(armies.status, "outbound"), inArray(armies.mission, ["raid", "conquer", "reinforce", "scout", "move"])));
      for (const army of out) {
        if (army.targetRegionId === p.capitalRegionId && army.mission === "move") continue;
        if (Object.entries(army.units).every(([id, n]) => n <= 0 || unitById.get(id)?.civilian)) continue;
        await db.transaction(async (tx) => {
          const travelled = Math.max(1000, now.getTime() - army.departsAt.getTime());
          const returnsAt = new Date(now.getTime() + travelled);
          await tx
            .update(jobs)
            .set({ cancelledAt: now })
            .where(and(eq(jobs.matchId, matchId), eq(jobs.kind, "mission"), eq(jobs.refId, army.id), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
          await tx.update(armies).set({ status: "returning", returnsAt, note: "recalled to rally" }).where(eq(armies.id, army.id));
          await tx.insert(jobs).values({ matchId, playerId: p.id, regionId: army.originRegionId, kind: "mission", refId: army.id, startsAt: now, endsAt: returnsAt });
        });
        recalled += 1;
      }
    }
    await publisher.toPlayer(matchId, p.id, "army.sent", { rally: true });
    return { ok: true, groups, soldiers, recalled, skipped };
  });

  /** Turn an outbound army around. It walks home over the time it has already spent travelling. */
  app.post("/api/matches/:id/armies/:armyId/recall", async (req) => {
    const user = requireUser(req);
    const { id: matchId, armyId } = req.params as { id: string; armyId: string };
    const { m, p } = await loadContext(matchId, user.id);
    const result = await db.transaction(async (tx) => {
      const [army] = await tx.select().from(armies).where(eq(armies.id, armyId)).for("update");
      if (!army || army.matchId !== matchId || army.playerId !== p.id) throw httpError(404, "army not found");
      if (army.status !== "outbound") throw httpError(409, "that army is already on its way back");
      const now = matchNow(m);
      const travelled = Math.max(1000, now.getTime() - army.departsAt.getTime());
      const returnsAt = new Date(now.getTime() + travelled);
      await tx
        .update(jobs)
        .set({ cancelledAt: now })
        .where(and(eq(jobs.matchId, matchId), eq(jobs.kind, "mission"), eq(jobs.refId, army.id), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
      await tx.update(armies).set({ status: "returning", returnsAt }).where(eq(armies.id, army.id));
      await tx.insert(jobs).values({ matchId, playerId: p.id, regionId: army.originRegionId, kind: "mission", refId: army.id, startsAt: now, endsAt: returnsAt });
      return { returnsAt, targetOwner: army.targetRegionId };
    });
    await publisher.toPlayer(matchId, p.id, "army.sent", { armyId, recalled: true });
    await publisher.toMatch(matchId, "region.updated", { regionId: result.targetOwner });
    return { ok: true, returnsAt: result.returnsAt.toISOString() };
  });

  app.post("/api/matches/:id/regions/:regionId/send", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
    const body = sendArmyBody.parse(req.body);
    const ctx = await loadContext(matchId, user.id);
    const { army, targetOwner, route } = await sendArmy(ctx, regionId, body);
    await publisher.toPlayer(matchId, ctx.p.id, "army.sent", { armyId: army.id });
    if (targetOwner && (body.mission === "raid" || body.mission === "conquer")) {
      await publisher.toPlayer(matchId, targetOwner, "army.incoming", { targetRegionId: body.targetRegionId, arrivesAt: army.arrivesAt.toISOString() });
    }
    return { ok: true, armyId: army.id, arrivesAt: army.arrivesAt.toISOString(), path: route.path };
  });
}
