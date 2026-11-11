import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { balance } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matches, players, tournamentRegistrations } from "../db/schema.js";
import type { SessionUser } from "../auth/session.js";
import { httpError } from "../sim/commands.js";

/**
 * A new account plays at once: until its email is confirmed it may be in (or registered for) one open match at a time
 * (balance.schedule.unverifiedMatchLimit). Confirming lifts the limit; chat and creating games still need it.
 * Half the sign-ups of October never opened the confirmation mail, so nothing waits on it any more.
 */
export async function assertMayPlay(db: Db, user: SessionUser, matchId: string): Promise<void> {
  if (user.approved || user.isAdmin) return;
  const [inMatches] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(players)
    .innerJoin(matches, eq(matches.id, players.matchId))
    .where(and(eq(players.userId, user.id), inArray(matches.status, ["lobby", "running"]), ne(players.matchId, matchId)));
  const [registered] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tournamentRegistrations)
    .innerJoin(matches, eq(matches.id, tournamentRegistrations.matchId))
    .where(and(eq(tournamentRegistrations.userId, user.id), eq(matches.status, "lobby"), ne(tournamentRegistrations.matchId, matchId)));
  if ((inMatches?.n ?? 0) + (registered?.n ?? 0) >= balance.schedule.unverifiedMatchLimit) {
    throw httpError(403, "confirm your email to play in more than one match at a time; the six-digit code is in your inbox");
  }
}
