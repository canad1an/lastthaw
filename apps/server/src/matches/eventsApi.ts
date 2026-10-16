import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { balance, regionById, proposePactBody, respondPactBody, lastStandBody, freezeDayForLatitude, findRoute, travelSeconds, armySpeed, unitById } from "@lastthaw/shared";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { armies, events, jobs, matchRegions, matches, playerTechs, players, refugeeOffers } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { requireUser } from "../auth/session.js";
import { httpError } from "../sim/commands.js";
import { matchNow } from "../sim/clock.js";
import { applyCost, settleAndLockRegion, stockOf, waySetsFor } from "../sim/regions.js";
import { alliesOf } from "../sim/alliances.js";
import { endPact, payTribute, proposePact, respondPact } from "../sim/diplomacy.js";
import { hireMercenaries } from "../sim/worldEvents.js";
import { notify } from "../worker/jobs.js";
import { idParams } from "./params.js";

const refugeeParams = z.object({ id: z.string().uuid(), offerId: z.string().uuid() });
const decideBody = z.object({ accept: z.boolean() });

/** Player decisions on world events: migrant columns for now; pacts, mercenaries and the last stand join later. */
export async function eventRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  app.post("/api/matches/:id/refugees/:offerId", async (req) => {
    const user = requireUser(req);
    const { id: matchId, offerId } = refugeeParams.parse(req.params);
    const { accept } = decideBody.parse(req.body);
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m || m.status !== "running") throw httpError(409, "the match is not running");
    if (m.pausedAt) throw httpError(409, "the match is paused");
    const [p] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, user.id))).limit(1);
    if (!p) throw httpError(403, "not a player in this match");
    const result = await decideRefugees(db, m, p, offerId, accept);
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId: result.regionId });
    return result;
  });
}

/** Pacts, ceasefires and tribute. */
export async function diplomacyRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;
  const ctx = async (req: { params: unknown; user: { id: string } | null }) => {
    const user = requireUser(req as Parameters<typeof requireUser>[0]);
    const matchId = idParams.parse(req.params).id;
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m || m.status !== "running") throw httpError(409, "the match is not running");
    if (m.pausedAt) throw httpError(409, "the match is paused");
    const [p] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, user.id))).limit(1);
    if (!p || p.eliminatedAt) throw httpError(403, "not an active player in this match");
    return { m, p };
  };
  app.post("/api/matches/:id/pacts", async (req) => {
    const { m, p } = await ctx(req);
    const body = proposePactBody.parse(req.body);
    const row = await proposePact(db, m, p, body.otherPlayerId, body.kind, body.kind === "tribute" ? { resource: body.resource ?? "food", amount: body.amount ?? 0 } : undefined);
    await publisher.toPlayer(m.id, body.otherPlayerId, "alliance.updated", { pact: row.id });
    return { ok: true, id: row.id };
  });
  app.post("/api/matches/:id/pacts/:pactId/respond", async (req) => {
    const { m, p } = await ctx(req);
    const { pactId } = pactParams.parse(req.params);
    const { accept } = respondPactBody.parse(req.body);
    const row = await respondPact(db, m, p, pactId, accept);
    await publisher.toPlayer(m.id, row.aPlayerId, "alliance.updated", { pact: row.id });
    return { ok: true, status: row.status };
  });
  app.post("/api/matches/:id/pacts/:pactId/end", async (req) => {
    const { m, p } = await ctx(req);
    const { pactId } = pactParams.parse(req.params);
    const row = await endPact(db, m, p, pactId);
    await publisher.toPlayer(m.id, row.aPlayerId === p.id ? row.bPlayerId : row.aPlayerId, "alliance.updated", { pact: row.id });
    return { ok: true, until: row.until?.toISOString() ?? null };
  });
  app.post("/api/matches/:id/pacts/:pactId/pay", async (req) => {
    const { m, p } = await ctx(req);
    const { pactId } = pactParams.parse(req.params);
    await payTribute(db, m, p, pactId);
    await publisher.toPlayer(m.id, p.id, "region.updated", {});
    return { ok: true };
  });

  /** Hire a mercenary company with iron from the capital. */
  app.post("/api/matches/:id/mercenaries/:offerId/hire", async (req) => {
    const { m, p } = await ctx(req);
    const { offerId } = offerParams.parse(req.params);
    const hired = await db.transaction((tx) => hireMercenaries(tx, m, p, offerId, matchNow(m)));
    await publisher.toPlayer(m.id, p.id, "region.updated", { regionId: p.capitalRegionId });
    return { ok: true, ...hired };
  });

  /** The last stand: once, when the ice is a day from the capital, everything marches south at double speed. */
  app.post("/api/matches/:id/last-stand", async (req) => {
    const { m, p } = await ctx(req);
    const { targetRegionId } = lastStandBody.parse(req.body);
    const ls = balance.events.lastStand;
    if (p.lastStandAt) throw httpError(409, "the last stand has already been made");
    if (!p.capitalRegionId) throw httpError(409, "you have no capital");
    const cap = regionById(p.capitalRegionId)!;
    const target = regionById(targetRegionId);
    if (!target) throw httpError(400, "unknown region");
    const now = matchNow(m);
    const day = ((now.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed;
    const freezeDay = freezeDayForLatitude(Math.abs(cap.lat)) ?? 999;
    if (freezeDay - day > ls.withinDays) throw httpError(409, `the ice is still ${(freezeDay - day).toFixed(1)} days from your capital; the last stand is for the final day`);
    if (Math.abs(target.lat) >= Math.abs(cap.lat)) throw httpError(400, "march toward the equator, not away from it");
    const techs = new Set((await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id))).map((r) => r.id));
    const { roads, rails, harbors } = await waySetsFor(db, m.id, p.id, await alliesOf(db, m.id, p.id));
    const route = findRoute(p.capitalRegionId, targetRegionId, techs.has(balance.travel.seaTech), roads, rails, harbors);
    if (!route) throw httpError(400, "no route there");
    const result = await db.transaction(async (tx) => {
      const ids = [p.capitalRegionId!, targetRegionId].sort();
      const locked = new Map<string, Awaited<ReturnType<typeof settleAndLockRegion>>>();
      for (const id of ids) locked.set(id, await settleAndLockRegion(tx, m.id, id, now, m.speed));
      const old = locked.get(p.capitalRegionId!)!;
      const dest = locked.get(targetRegionId)!;
      if (dest.ownerPlayerId !== p.id || dest.frozenAt) throw httpError(400, "the destination must be an unfrozen region of yours");
      // Everything goes: every unit, every person, every store, carry limits ignored.
      const units: Record<string, number> = {};
      for (const [id, n] of Object.entries(old.units)) if (n > 0) units[id] = n;
      const people = Math.floor(old.popWorkers + old.popOccupiers);
      const cargo: Record<string, number> = { people };
      for (const [k, v] of Object.entries(stockOf(old))) if (v >= 1) cargo[k] = Math.floor(v);
      const speed = (Object.keys(units).length ? armySpeed(units) : (unitById.get("settler")?.speed ?? 4)) * ls.speedMult;
      const seconds = travelSeconds(route, speed, m.speed);
      const arrivesAt = new Date(now.getTime() + seconds * 1000);
      const { people: _p, ...goods } = cargo;
      if (Object.keys(goods).length) await applyCost(tx, old, goods);
      await tx.update(matchRegions).set({ units: {}, popSoldiers: 0, popWorkers: 0, popOccupiers: 0, evacuatedAt: now }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, old.regionId)));
      const [a] = await tx
        .insert(armies)
        .values({ matchId: m.id, playerId: p.id, mission: "relocate", originRegionId: old.regionId, targetRegionId, units, cargo, path: route.path, status: "outbound", departsAt: now, arrivesAt, note: "the last stand" })
        .returning();
      await tx.insert(jobs).values({ matchId: m.id, playerId: p.id, regionId: targetRegionId, kind: "mission", refId: a!.id, startsAt: now, endsAt: arrivesAt });
      await tx.update(players).set({ lastStandAt: now }).where(eq(players.id, p.id));
      await tx.insert(events).values({ matchId: m.id, at: now, kind: "last.stand", payload: { playerId: p.id, regionId: targetRegionId, from: old.regionId } });
      await notify(tx, m.id, p.id, "system", `The last stand: ${people} people, every unit and every store leave ${regionById(old.regionId)?.name} for ${target.name} at double speed. The capital moves when they arrive.`, { regionId: targetRegionId, arrivesAt: arrivesAt.toISOString() });
      return { armyId: a!.id, arrivesAt };
    });
    await publisher.toPlayer(m.id, p.id, "army.sent", { armyId: result.armyId, relocate: targetRegionId });
    return { ok: true, armyId: result.armyId, arrivesAt: result.arrivesAt.toISOString() };
  });
}

const pactParams = z.object({ id: z.string().uuid(), pactId: z.string().uuid() });
const offerParams = z.object({ id: z.string().uuid(), offerId: z.string().uuid() });

/** Take a column in (people arrive now, food is paid from the region or the capital) or send it on. Shared with the AI. */
export async function decideRefugees(db: Db, m: typeof matches.$inferSelect, p: typeof players.$inferSelect, offerId: string, accept: boolean) {
  const now = matchNow(m);
  return db.transaction(async (tx) => {
    const [offer] = await tx.select().from(refugeeOffers).where(and(eq(refugeeOffers.id, offerId), eq(refugeeOffers.matchId, m.id), eq(refugeeOffers.playerId, p.id), isNull(refugeeOffers.decidedAt))).for("update");
    if (!offer) throw httpError(404, "no such column is waiting for you");
    if (offer.expiresAt <= now) {
      await tx.update(refugeeOffers).set({ decidedAt: now, accepted: false }).where(eq(refugeeOffers.id, offer.id));
      throw httpError(409, "that column has moved on");
    }
    if (!accept) {
      await tx.update(refugeeOffers).set({ decidedAt: now, accepted: false }).where(eq(refugeeOffers.id, offer.id));
      return { ok: true, accepted: false, regionId: offer.regionId };
    }
    const cost = offer.people * balance.events.refugees.foodPerPerson;
    // Food comes from the region first, then the capital; lock in ascending order.
    const ids = [...new Set([offer.regionId, ...(p.capitalRegionId ? [p.capitalRegionId] : [])])].sort();
    const rows = new Map<string, Awaited<ReturnType<typeof settleAndLockRegion>>>();
    for (const id of ids) rows.set(id, await settleAndLockRegion(tx, m.id, id, now, m.speed));
    const region = rows.get(offer.regionId)!;
    if (region.ownerPlayerId !== p.id || region.frozenAt) throw httpError(409, "that region is no longer yours");
    const capital = p.capitalRegionId && p.capitalRegionId !== offer.regionId ? rows.get(p.capitalRegionId) : null;
    const here = Math.min(cost, stockOf(region).food ?? 0);
    const fromCapital = capital && capital.ownerPlayerId === p.id ? Math.min(cost - here, stockOf(capital).food ?? 0) : 0;
    if (here + fromCapital < cost) throw httpError(409, `taking them in costs ${cost} food; you have ${Math.floor(here + fromCapital)} between ${regionById(offer.regionId)?.name} and the capital`);
    if (here > 0) await applyCost(tx, region, { food: here });
    if (fromCapital > 0 && capital) await applyCost(tx, capital, { food: fromCapital });
    await tx.update(matchRegions).set({ popWorkers: region.popWorkers + offer.people }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, offer.regionId)));
    await tx.update(refugeeOffers).set({ decidedAt: now, accepted: true }).where(eq(refugeeOffers.id, offer.id));
    await notify(tx, m.id, p.id, "system", `${offer.people} people from ${regionById(offer.fromRegionId)?.name ?? "the north"} have settled in ${regionById(offer.regionId)?.name ?? offer.regionId}.`, { regionId: offer.regionId, people: offer.people });
    return { ok: true, accepted: true, regionId: offer.regionId, people: offer.people, food: cost };
  });
}
