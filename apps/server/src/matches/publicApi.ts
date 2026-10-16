import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AGES, allRegions, balance, iceLatitudeOnDay } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matchRegions, matches, players, userMatchResults, users, events } from "../db/schema.js";

/**
 * Titles earned across ranked matches: Survivor (survival wins), Conqueror (hold wins),
 * Builder (wonder wins), Explorer (five or more expeditions returned). Each carries a count.
 */
export async function titlesOf(db: Db, userIds: string[]): Promise<Map<string, Array<{ title: string; n: number }>>> {
  const out = new Map<string, Array<{ title: string; n: number }>>();
  if (userIds.length === 0) return out;
  const wins = await db
    .select({ userId: userMatchResults.userId, kind: userMatchResults.winKind, n: sql<number>`count(*)::int` })
    .from(userMatchResults)
    .where(and(inArray(userMatchResults.userId, userIds), eq(userMatchResults.won, true), eq(userMatchResults.ranked, true)))
    .groupBy(userMatchResults.userId, userMatchResults.winKind);
  const names: Record<string, string> = { survival: "Survivor", hold: "Conqueror", wonder: "Builder" };
  for (const w of wins) {
    const title = names[w.kind ?? ""];
    if (!title) continue;
    out.set(w.userId, [...(out.get(w.userId) ?? []), { title, n: w.n }]);
  }
  const trips = await db
    .select({ userId: players.userId, n: sql<number>`count(*)::int` })
    .from(events)
    .innerJoin(players, sql`${players.id} = (${events.payload}->>'playerId')::uuid`)
    .innerJoin(userMatchResults, and(eq(userMatchResults.playerId, players.id), eq(userMatchResults.ranked, true)))
    .where(and(eq(events.kind, "expedition.returned"), inArray(players.userId, userIds)))
    .groupBy(players.userId);
  for (const t of trips) if (t.userId && t.n >= 5) out.set(t.userId, [...(out.get(t.userId) ?? []), { title: "Explorer", n: t.n }]);
  return out;
}
import { matchNow } from "../sim/clock.js";

/** Public, login-free views for the home page: matches in play, top players, past winners. */
export async function publicRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.get("/api/public/matches", async () => {
    const rows = await db
      .select()
      .from(matches)
      .where(inArray(matches.status, ["lobby", "running"]))
      .orderBy(matches.startsAt);
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await db
          .select({ matchId: players.matchId, humans: sql<number>`count(*) filter (where not is_ai)::int`, ai: sql<number>`count(*) filter (where is_ai)::int` })
          .from(players)
          .where(inArray(players.matchId, ids))
          .groupBy(players.matchId)
      : [];
    const countBy = new Map(counts.map((c) => [c.matchId, c]));
    const owned = ids.length
      ? await db
          .select({ matchId: matchRegions.matchId, n: sql<number>`count(*)::int` })
          .from(matchRegions)
          .where(and(inArray(matchRegions.matchId, ids), sql`${matchRegions.ownerPlayerId} is not null`))
          .groupBy(matchRegions.matchId)
      : [];
    const ownedBy = new Map(owned.map((o) => [o.matchId, o.n]));
    const leaders = ids.length
      ? await db
          .select({ matchId: players.matchId, name: players.name, score: players.score, isAi: players.isAi })
          .from(players)
          .where(inArray(players.matchId, ids))
          .orderBy(desc(players.score))
      : [];
    const topBy = new Map<string, Array<{ name: string; score: number; isAi: boolean }>>();
    for (const l of leaders) {
      const list = topBy.get(l.matchId) ?? [];
      if (list.length < 3) list.push({ name: l.name, score: l.score, isAi: l.isAi });
      topBy.set(l.matchId, list);
    }
    const total = allRegions().length;
    return rows.map((m) => {
      const now = matchNow(m);
      const day = m.status === "lobby" ? 0 : Math.min(balance.match.lengthDays, ((now.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed);
      return {
        id: m.id,
        name: m.name,
        status: m.status,
        speed: m.speed,
        startsAt: m.startsAt.toISOString(),
        endsAt: m.endsAt.toISOString(),
        day,
        iceLatitude: iceLatitudeOnDay(day),
        humans: countBy.get(m.id)?.humans ?? 0,
        ai: countBy.get(m.id)?.ai ?? 0,
        claimedRegions: ownedBy.get(m.id) ?? 0,
        totalRegions: total,
        top: topBy.get(m.id) ?? [],
      };
    });
  });

  app.get("/api/public/hall-of-fame", async () => {
    const finished = await db
      .select()
      .from(matches)
      .where(eq(matches.status, "finished"))
      .orderBy(desc(matches.finishedAt))
      .limit(50);
    const out = [];
    for (const m of finished) {
      const [winner] = m.winnerPlayerId ? await db.select().from(players).where(eq(players.id, m.winnerPlayerId)).limit(1) : [];
      const top = await db
        .select({ name: players.name, score: players.score, isAi: players.isAi, age: players.age })
        .from(players)
        .where(and(eq(players.matchId, m.id), eq(players.hidden, false)))
        .orderBy(desc(players.score))
        .limit(3);
      const [regions] = winner
        ? await db
            .select({ n: sql<number>`count(*)::int` })
            .from(matchRegions)
            .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, winner.id)))
        : [];
      out.push({
        id: m.id,
        name: m.name,
        speed: m.speed,
        startedAt: m.startsAt.toISOString(),
        finishedAt: m.finishedAt?.toISOString() ?? null,
        winner: winner ? { name: winner.name, isAi: winner.isAi, age: AGES[winner.age as 0 | 1 | 2 | 3 | 4], score: winner.score, regions: regions?.n ?? 0 } : null,
        top: top.map((t) => ({ name: t.name, score: t.score, isAi: t.isAi, age: AGES[t.age as 0 | 1 | 2 | 3 | 4] })),
      });
    }
    // Most wins by account.
    const champions = await db
      .select({ userId: users.id, name: users.displayName, wins: sql<number>`count(*) filter (where ${userMatchResults.won})::int`, played: sql<number>`count(*)::int`, best: sql<number>`min(${userMatchResults.finalRank})::int`, score: sql<number>`coalesce(sum(${userMatchResults.score}), 0)::int` })
      .from(userMatchResults)
      .innerJoin(users, eq(users.id, userMatchResults.userId))
      .where(eq(userMatchResults.ranked, true))
      .groupBy(users.id, users.displayName)
      .orderBy(desc(sql`count(*) filter (where ${userMatchResults.won})`), desc(sql`coalesce(sum(${userMatchResults.score}), 0)`))
      .limit(20);
    const titles = await titlesOf(db, champions.map((c) => c.userId));
    return { matches: out, champions: champions.map(({ userId, ...c }) => ({ ...c, titles: titles.get(userId) ?? [] })) };
  });
}
