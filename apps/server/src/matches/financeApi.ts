import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import type { FinanceView } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { economyHistory, matches, players, spendLedger } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import { httpError } from "../sim/commands.js";
import { matchDayAt, matchNow } from "../sim/clock.js";
import { economyNow } from "../sim/ledger.js";
import { idParams } from "./params.js";

/** The player's own books: production now and over time, and what was spent on what, by game day. */
export async function financeRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.get("/api/matches/:id/finance", async (req): Promise<FinanceView> => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    const [p] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, user.id))).limit(1);
    if (!p) throw httpError(403, "not a player in this match");
    const now = matchNow(m);
    const live = await economyNow(db, m, p.id, now);
    const history = await db.select().from(economyHistory).where(and(eq(economyHistory.matchId, matchId), eq(economyHistory.playerId, p.id))).orderBy(asc(economyHistory.day));
    const spending = await db.select().from(spendLedger).where(and(eq(spendLedger.matchId, matchId), eq(spendLedger.playerId, p.id))).orderBy(asc(spendLedger.day));
    return {
      day: matchDayAt(m, now),
      now: { gross: live.gross, eaten: live.eaten, regions: live.regions },
      history: history.map((h) => ({ day: h.day, gross: h.gross as Record<string, number>, eaten: h.eaten as { people: number; soldiers: number }, regions: h.regions })),
      spending: spending.map((s) => ({ day: s.day, category: s.category, resource: s.resource, amount: s.amount })),
    };
  });
}
