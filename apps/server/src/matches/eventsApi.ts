import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { balance, regionById } from "@lastthaw/shared";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { matchRegions, matches, players, refugeeOffers } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { requireUser } from "../auth/session.js";
import { httpError } from "../sim/commands.js";
import { matchNow } from "../sim/clock.js";
import { applyCost, settleAndLockRegion, stockOf } from "../sim/regions.js";
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
