import type { FastifyInstance } from "fastify";
import { parseProfile } from "../sim/ai.js";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { AGES, allRegions, balance, iceLatitudeOnDay } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { allianceMembers, alliances, matchRegions, matches, players, userMatchResults, users } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import { matchNow } from "../sim/clock.js";

/** Live leaderboard (public within a match), match day/ice status, and per-account history. */
export async function leaderboardRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.get("/api/matches/:id/leaderboard", async (req, reply) => {
    requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) return reply.code(404).send({ error: "match not found" });
    const ps = await db.select().from(players).where(eq(players.matchId, matchId)).orderBy(desc(players.score));
    const stats = await db
      .select({
        owner: matchRegions.ownerPlayerId,
        regions: sql<number>`count(*)::int`,
        pop: sql<number>`coalesce(sum(${matchRegions.popWorkers} + ${matchRegions.popSoldiers} + ${matchRegions.popOccupiers}), 0)::float`,
      })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, matchId), sql`${matchRegions.ownerPlayerId} is not null`))
      .groupBy(matchRegions.ownerPlayerId);
    const statBy = new Map(stats.map((s) => [s.owner!, s]));
    const members = await db
      .select({ playerId: allianceMembers.playerId, tag: alliances.tag })
      .from(allianceMembers)
      .innerJoin(alliances, eq(alliances.id, allianceMembers.allianceId))
      .where(eq(allianceMembers.matchId, matchId));
    const tagBy = new Map(members.map((x) => [x.playerId, x.tag]));
    const now = matchNow(m);
    const day = m.status === "lobby" ? 0 : Math.min(balance.match.lengthDays, ((now.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed);
    const total = allRegions().length;
    return {
      match: { id: m.id, name: m.name, status: m.status, speed: m.speed, day, iceLatitude: iceLatitudeOnDay(day), totalRegions: total, winnerPlayerId: m.winnerPlayerId },
      players: ps.map((p, i) => ({
        rank: i + 1,
        id: p.id,
        name: p.name,
        isAi: p.isAi,
        aiLevel: p.isAi ? parseProfile(p.aiProfile).difficulty : null,
        allianceTag: tagBy.get(p.id) ?? null,
        age: p.age,
        ageName: AGES[p.age as 0 | 1 | 2 | 3 | 4],
        score: p.score,
        regions: statBy.get(p.id)?.regions ?? 0,
        population: Math.round(statBy.get(p.id)?.pop ?? 0),
        eliminated: p.eliminatedAt !== null,
      })),
    };
  });

  /** Account history across matches, for the profile page. */
  app.get("/api/me/history", async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select({ r: userMatchResults, name: matches.name, speed: matches.speed, finishedAt: matches.finishedAt })
      .from(userMatchResults)
      .innerJoin(matches, eq(matches.id, userMatchResults.matchId))
      .where(eq(userMatchResults.userId, user.id))
      .orderBy(desc(userMatchResults.recordedAt))
      .limit(50);
    const active = await db
      .select({ matchId: players.matchId, name: matches.name, status: matches.status })
      .from(players)
      .innerJoin(matches, eq(matches.id, players.matchId))
      .where(and(eq(players.userId, user.id), inArray(matches.status, ["lobby", "running"]), isNull(players.eliminatedAt)));
    return {
      history: rows.map((x) => ({
        matchId: x.r.matchId,
        name: x.name,
        speed: x.speed,
        finishedAt: x.finishedAt?.toISOString() ?? null,
        rank: x.r.finalRank,
        score: x.r.score,
        regions: x.r.regionsHeld,
        age: AGES[x.r.ageReached as 0 | 1 | 2 | 3 | 4],
        won: x.r.won,
      })),
      active: active.map((a) => ({ matchId: a.matchId, name: a.name, status: a.status })),
      wins: rows.filter((x) => x.r.won).length,
      played: rows.length,
    };
  });

  // Keep `users` referenced for future profile fields.
  void users;
}
