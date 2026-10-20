import type { FastifyInstance } from "fastify";
import { parseProfile } from "../sim/ai.js";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { AGES, allRegions, balance, buildingById, iceLatitudeOnDay, regionById } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { allianceMembers, alliances, jobs, matchMilestones, matchRegions, matches, players, userMatchResults, users, battles, scoreHistory, ownershipFrames, dailyObjectives } from "../db/schema.js";
import { OBJECTIVES } from "../sim/objectives.js";
import { buildStory, playerArcs } from "./story.js";
import { isTournament } from "./registrations.js";
import { titlesOf } from "./publicApi.js";

/** Today's objective and yesterday's winner, for the leaderboard. */
async function objectiveOf(db: Db, m: { id: string; startsAt: Date; speed: number; finishedAt: Date | null }) {
  const at = m.finishedAt ?? new Date();
  const dayIdx = Math.max(0, Math.min(29, Math.floor(((at.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed)));
  const rows = await db
    .select({ o: dailyObjectives, name: players.name })
    .from(dailyObjectives)
    .leftJoin(players, eq(players.id, dailyObjectives.winnerPlayerId))
    .where(and(eq(dailyObjectives.matchId, m.id), inArray(dailyObjectives.day, [dayIdx, dayIdx - 1])));
  const today = rows.find((r) => r.o.day === dayIdx);
  const yday = rows.find((r) => r.o.day === dayIdx - 1);
  return today ? { day: today.o.day + 1, label: OBJECTIVES[today.o.key] ?? today.o.key, yesterday: yday ? { label: OBJECTIVES[yday.o.key] ?? yday.o.key, winnerName: yday.name, value: yday.o.value ?? 0 } : null } : null;
}
import { milestoneLabel, milestonePoints } from "../sim/endgame.js";
import { requireUser } from "../auth/session.js";
import { httpError } from "../sim/commands.js";
import { idParams } from "./params.js";
import { matchNow } from "../sim/clock.js";

/** Live leaderboard (public within a match), match day/ice status, and per-account history. */
export async function leaderboardRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const matchIdParam = (req: { params: unknown }) => idParams.parse(req.params).id;
  const isMember = async (matchId: string, userId: string) => {
    const [p] = await db.select({ id: players.id }).from(players).where(and(eq(players.matchId, matchId), eq(players.userId, userId))).limit(1);
    return !!p;
  };
  /** A private game's pages are for the people who played it and admins, before and after it ends. */
  const guardPrivate = async (m: { id: string; settings: unknown }, user: { id: string; isAdmin: boolean } | null) => {
    if (((m.settings ?? {}) as { kind?: string }).kind !== "private") return;
    if (user?.isAdmin) return;
    if (user && (await isMember(m.id, user.id))) return;
    throw httpError(403, "this is a private game: its pages are only for the people who played it");
  };

  app.get("/api/matches/:id/leaderboard", async (req, reply) => {
    const user = requireUser(req);
    const matchId = matchIdParam(req);
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) return reply.code(404).send({ error: "match not found" });
    await guardPrivate(m, user);
    // Live standings are for the people in the match; everyone can read them once it is over.
    const member = await isMember(matchId, user.id);
    if (m.status !== "finished" && !member && !user.isAdmin) throw httpError(403, "only players in this match can see its standings while it runs");
    const ps = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, false))).orderBy(desc(players.score));
    // Once the match is over the winner stands first whatever the score says (a survival win goes by people alive, a wonder by who built it), as the final ranks do.
    if (m.winnerPlayerId) ps.sort((a, b) => Number(b.id === m.winnerPlayerId) - Number(a.id === m.winnerPlayerId) || b.score - a.score);
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
    const nameOf = new Map(ps.map((p) => [p.id, p.name]));
    const milestones = (await db.select().from(matchMilestones).where(eq(matchMilestones.matchId, matchId)).orderBy(matchMilestones.at)).map((x) => ({
      key: x.key,
      label: x.key.startsWith("capital_") ? `Took ${nameOf.get(x.key.slice(8)) ?? "a tribe"}'s capital` : milestoneLabel(x.key),
      playerId: x.playerId,
      playerName: nameOf.get(x.playerId) ?? "?",
      points: milestonePoints(x.key),
      at: x.at.toISOString(),
    }));
    const wonders = (
      await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.matchId, matchId), eq(jobs.kind, "build"), eq(jobs.refId, balance.win.wonderBuilding), isNull(jobs.completedAt), isNull(jobs.cancelledAt)))
    ).map((j) => ({ playerId: j.playerId, playerName: nameOf.get(j.playerId ?? "") ?? "?", regionId: member ? j.regionId : null, regionName: member ? (regionById(j.regionId ?? "")?.name ?? j.regionId) : "a capital", endsAt: j.endsAt.toISOString(), waiting: !!j.waitingFor }));
    return {
      match: { id: m.id, slug: m.slug ?? m.id, name: m.name, status: m.status, speed: m.speed, day, iceLatitude: iceLatitudeOnDay(day), totalRegions: total, winnerPlayerId: m.winnerPlayerId, survival: balance.win.survival, wonderName: buildingById.get(balance.win.wonderBuilding)?.name ?? "wonder" },
      milestones,
      objective: await objectiveOf(db, m),
      wonders,
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

  /** The end-of-match report: how it ended, standings, firsts, growth of every player's score by day, and a few totals. */
  app.get("/api/matches/:id/summary", async (req, reply) => {
    // Public once the match is over: the report page lives at its URL forever, for anyone.
    const user = req.user ?? null;
    const matchId = matchIdParam(req);
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) return reply.code(404).send({ error: "match not found" });
    await guardPrivate(m, user);
    if (m.status !== "finished" && !(user && (user.isAdmin || (await isMember(matchId, user.id))))) throw httpError(403, "the report is published when the match ends");
    const ps = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, false))).orderBy(desc(players.score));
    const me = user ? ps.find((p) => p.userId === user.id) : undefined;
    const stats = await db
      .select({
        owner: matchRegions.ownerPlayerId,
        regions: sql<number>`count(*)::int`,
        pop: sql<number>`coalesce(sum(${matchRegions.popWorkers} + ${matchRegions.popSoldiers} + ${matchRegions.popOccupiers}), 0)::float`,
      })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, matchId), sql`${matchRegions.ownerPlayerId} is not null`, isNull(matchRegions.frozenAt)))
      .groupBy(matchRegions.ownerPlayerId);
    const statBy = new Map(stats.map((s) => [s.owner!, s]));
    const members = await db
      .select({ playerId: allianceMembers.playerId, tag: alliances.tag })
      .from(allianceMembers)
      .innerJoin(alliances, eq(alliances.id, allianceMembers.allianceId))
      .where(eq(allianceMembers.matchId, matchId));
    const tagBy = new Map(members.map((x) => [x.playerId, x.tag]));
    const results = await db.select({ playerId: userMatchResults.playerId, rank: userMatchResults.finalRank }).from(userMatchResults).where(eq(userMatchResults.matchId, matchId));
    const rankBy = new Map(results.map((r) => [r.playerId, r.rank]));
    // Rank: the winner first, then by score; recorded ranks for humans win over the live order.
    const ordered = [...ps].sort((a, b) => Number(b.id === m.winnerPlayerId) - Number(a.id === m.winnerPlayerId) || b.score - a.score);
    const standings = ordered.map((p, i) => ({
      rank: rankBy.get(p.id) ?? i + 1,
      id: p.id,
      name: p.name,
      isAi: p.isAi,
      allianceTag: tagBy.get(p.id) ?? null,
      age: p.age,
      score: p.score,
      regions: statBy.get(p.id)?.regions ?? 0,
      population: Math.round(statBy.get(p.id)?.pop ?? 0),
      eliminated: p.eliminatedAt !== null,
      won: p.id === m.winnerPlayerId,
    }));
    const nameOf = new Map(ps.map((p) => [p.id, p.name]));
    const milestones = (await db.select().from(matchMilestones).where(eq(matchMilestones.matchId, matchId)).orderBy(matchMilestones.at)).map((x) => ({
      key: x.key,
      label: x.key.startsWith("capital_") ? `Took ${nameOf.get(x.key.slice(8)) ?? "a tribe"}'s capital` : milestoneLabel(x.key),
      playerId: x.playerId,
      playerName: nameOf.get(x.playerId) ?? "?",
      points: milestonePoints(x.key),
      at: x.at.toISOString(),
    }));
    const hist = await db.select().from(scoreHistory).where(eq(scoreHistory.matchId, matchId)).orderBy(scoreHistory.day);
    const history: Record<string, Array<{ day: number; score: number; regions: number; population: number }>> = {};
    for (const h of hist) (history[h.playerId] ??= []).push({ day: h.day, score: h.score, regions: h.regions, population: h.population });
    const [bt] = await db.select({ n: sql<number>`count(*)::int` }).from(battles).where(eq(battles.matchId, matchId));
    // The story of the match and each player's arc through it, for the written report and the sharing card.
    const arcs = await playerArcs(db, matchId, ps);
    const story = await buildStory(db, m, ps, standings);
    return {
      match: { id: m.id, slug: m.slug ?? m.id, name: m.name, speed: m.speed, startsAt: m.startsAt.toISOString(), finishedAt: m.finishedAt?.toISOString() ?? null, winnerPlayerId: m.winnerPlayerId, winKind: m.winKind ?? null, wonderName: buildingById.get(balance.win.wonderBuilding)?.name ?? "wonder", tournament: isTournament(m.settings) },
      me: { playerId: me?.id ?? "", rank: me ? (standings.find((s) => s.id === me.id)?.rank ?? null) : null },
      standings: standings.map((s) => ({ ...s, ...(arcs.get(s.id) ?? { peakRank: null, battles: 0, battlesWon: 0, conquests: 0, techs: 0 }) })),
      story,
      milestones,
      objective: await objectiveOf(db, m),
      history,
      totals: { battles: bt?.n ?? 0, regionsHeld: standings.reduce((a, p) => a + p.regions, 0), agesReached: Math.max(0, ...ps.map((p) => p.age + 1)), players: ps.length, humans: ps.filter((p) => !p.isAi).length },
    };
  });

  /** Replay frames for a match: public, like the report. A match recorded before replays existed gets its final positions as one frame. */
  app.get("/api/matches/:id/replay", async (req, reply) => {
    const matchId = matchIdParam(req);
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) return reply.code(404).send({ error: "match not found" });
    await guardPrivate(m, req.user ?? null);
    // The whole map, with every owner, is only for finished matches: during play it would be total vision.
    if (m.status !== "finished" && !req.user?.isAdmin) throw httpError(403, "the replay is published when the match ends");
    const ps = await db.select({ id: players.id, name: players.name, isAi: players.isAi }).from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, false))).orderBy(players.createdAt);
    let frames = (await db.select().from(ownershipFrames).where(eq(ownershipFrames.matchId, matchId)).orderBy(ownershipFrames.day)).map((f) => ({ day: f.day, changes: f.changes }));
    if (frames.length === 0 && m.status !== "lobby") {
      const rows = await db
        .select({ regionId: matchRegions.regionId, owner: matchRegions.ownerPlayerId, frozen: matchRegions.frozenAt })
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, matchId), sql`(${matchRegions.ownerPlayerId} is not null or ${matchRegions.frozenAt} is not null)`));
      const changes: Record<string, string | null> = {};
      for (const r of rows) changes[r.regionId] = r.frozen ? "ice" : r.owner;
      const now = matchNow(m);
      const day = Math.min(balance.match.lengthDays, Math.max(0, ((now.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed));
      frames = [{ day: Math.round(day * 4) / 4, changes }];
    }
    return {
      match: { id: m.id, slug: m.slug ?? m.id, name: m.name, status: m.status, speed: m.speed, finishedAt: m.finishedAt?.toISOString() ?? null, winnerPlayerId: m.winnerPlayerId },
      players: ps,
      frames,
    };
  });

  /** Finished matches, newest first, for the lobby's Past matches list. Public. */
  app.get("/api/matches/past", async () => {
    const rows = await db.select().from(matches).where(eq(matches.status, "finished")).orderBy(desc(matches.finishedAt)).limit(30);
    const ids = rows.map((r) => r.id);
    const winners = ids.length ? await db.select({ id: players.id, name: players.name }).from(players).where(inArray(players.id, rows.map((r) => r.winnerPlayerId).filter((x): x is string => !!x))) : [];
    const counts = ids.length
      ? await db
          .select({ matchId: players.matchId, humans: sql<number>`count(*) filter (where not is_ai)::int`, total: sql<number>`count(*) filter (where not hidden)::int` })
          .from(players)
          .where(inArray(players.matchId, ids))
          .groupBy(players.matchId)
      : [];
    const countBy = new Map(counts.map((c) => [c.matchId, c]));
    const winnerBy = new Map(winners.map((w) => [w.id, w.name]));
    return {
      matches: rows.map((m) => ({
        id: m.id,
        slug: m.slug ?? m.id,
        name: m.name,
        speed: m.speed,
        startsAt: m.startsAt.toISOString(),
        finishedAt: m.finishedAt?.toISOString() ?? null,
        winnerName: m.winnerPlayerId ? (winnerBy.get(m.winnerPlayerId) ?? null) : null,
        winKind: m.winKind ?? null,
        kind: ((m.settings ?? {}) as { kind?: string; weekly?: boolean }).kind ?? (((m.settings ?? {}) as { weekly?: boolean }).weekly ? "tournament" : "public"),
        humans: countBy.get(m.id)?.humans ?? 0,
        players: countBy.get(m.id)?.total ?? 0,
      })),
    };
  });

  /** Account history across matches, for the profile page. */
  app.get("/api/me/history", async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select({ r: userMatchResults, name: matches.name, slug: matches.slug, speed: matches.speed, finishedAt: matches.finishedAt })
      .from(userMatchResults)
      .innerJoin(matches, eq(matches.id, userMatchResults.matchId))
      .where(eq(userMatchResults.userId, user.id))
      .orderBy(desc(userMatchResults.recordedAt))
      .limit(50);
    const active = await db
      .select({ matchId: players.matchId, slug: matches.slug, name: matches.name, status: matches.status })
      .from(players)
      .innerJoin(matches, eq(matches.id, players.matchId))
      .where(and(eq(players.userId, user.id), inArray(matches.status, ["lobby", "running"]), isNull(players.eliminatedAt)));
    return {
      history: rows.map((x) => ({
        matchId: x.r.matchId,
        slug: x.slug ?? x.r.matchId,
        name: x.name,
        speed: x.speed,
        finishedAt: x.finishedAt?.toISOString() ?? null,
        rank: x.r.finalRank,
        score: x.r.score,
        regions: x.r.regionsHeld,
        age: AGES[x.r.ageReached as 0 | 1 | 2 | 3 | 4],
        won: x.r.won,
      })),
      active: active.map((a) => ({ matchId: a.matchId, slug: a.slug ?? a.matchId, name: a.name, status: a.status })),
      wins: rows.filter((x) => x.r.won).length,
      played: rows.length,
      titles: (await titlesOf(db, [user.id])).get(user.id) ?? [],
    };
  });

  // Keep `users` referenced for future profile fields.
  void users;
}
