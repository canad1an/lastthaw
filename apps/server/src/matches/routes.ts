import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { assignBody, balance, createMatchBody, normalizeAssignment, pickStartBody, regionById, timeSkipBody, type MatchSummary, joinMatchBody, joinByCodeBody } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matchRegions, matches, players, tournamentRegistrations } from "../db/schema.js";
import { isTournament, joinOpensAt } from "./registrations.js";
import { uniqueSlug } from "./slug.js";
import { requireUser, requireVerified } from "../auth/session.js";
import { config } from "../config.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { settleAndLockRegion } from "../sim/regions.js";
import { buildMatchState } from "../view/matchState.js";
import { startMatch, matchLengthSeconds, enrolRegistered } from "./start.js";
import { finishMatch } from "../sim/endgame.js";
import { farEnough, startOptionsFor } from "./startOptions.js";
import { pickMatchName } from "../worker/weekly.js";
import { idParams, regionParams } from "./params.js";

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

export async function matchRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;
  const devTools = config().DEV_TOOLS;

  async function myPlayer(matchId: string, userId: string) {
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
      .limit(1);
    return p ?? null;
  }

  async function takenCapitals(matchId: string): Promise<string[]> {
    const rows = await db.select({ c: players.capitalRegionId }).from(players).where(eq(players.matchId, matchId));
    return rows.map((r) => r.c).filter((c): c is string => !!c);
  }

  app.get("/api/matches", async (req) => {
    const user = req.user;
    const rows = await db
      .select()
      .from(matches)
      .where(inArray(matches.status, ["lobby", "running"]))
      .orderBy(matches.startsAt);
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await db
          .select({ matchId: players.matchId, n: sql<number>`count(*) filter (where not is_ai)::int`, all: sql<number>`count(*) filter (where not hidden)::int` })
          .from(players)
          .where(inArray(players.matchId, ids))
          .groupBy(players.matchId)
      : [];
    const countBy = new Map(counts.map((c) => [c.matchId, c.n]));
    const allBy = new Map(counts.map((c) => [c.matchId, c.all]));
    const regs = ids.length
      ? await db
          .select({ matchId: tournamentRegistrations.matchId, n: sql<number>`count(*)::int`, mine: sql<number>`count(*) filter (where ${tournamentRegistrations.userId} = ${user?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid)::int` })
          .from(tournamentRegistrations)
          .where(inArray(tournamentRegistrations.matchId, ids))
          .groupBy(tournamentRegistrations.matchId)
      : [];
    const regBy = new Map(regs.map((r) => [r.matchId, r]));
    const mine = user
      ? await db
          .select({ matchId: players.matchId, id: players.id, capital: players.capitalRegionId })
          .from(players)
          .where(and(eq(players.userId, user.id), ids.length ? inArray(players.matchId, ids) : sql`false`))
      : [];
    const mineBy = new Map(mine.map((p) => [p.matchId, p]));
    const out: MatchSummary[] = [];
    for (const m of rows) {
      const mp = mineBy.get(m.id);
      const s = (m.settings ?? {}) as { kind?: "tournament" | "public" | "private"; weekly?: boolean; inviteCode?: string; createdBy?: string };
      const kind = s.kind ?? (s.weekly ? "tournament" : "public");
      const createdByMe = !!user && s.createdBy === user.id;
      // Private games are only listed to their creator, the people already in them, and admins (who may look into any match).
      if (kind === "private" && !createdByMe && !mp && !user?.isAdmin) continue;
      out.push({
        id: m.id,
        slug: m.slug ?? m.id,
        name: m.name,
        status: m.status,
        speed: m.speed,
        startsAt: m.startsAt.toISOString(),
        endsAt: m.endsAt.toISOString(),
        humanPlayers: countBy.get(m.id) ?? 0,
        // Every seat is taken once a match runs: humans plus the AI tribes that filled the rest.
        players: m.status === "lobby" ? (countBy.get(m.id) ?? 0) : (allBy.get(m.id) ?? 0),
        maxPlayers: balance.match.maxHumanPlayers,
        joined: !!mp,
        playerId: mp?.id ?? null,
        capitalRegionId: mp?.capital ?? null,
        kind,
        inviteCode: createdByMe ? (s.inviteCode ?? null) : null,
        createdByMe,
        registrations: regBy.get(m.id)?.n ?? 0,
        registered: (regBy.get(m.id)?.mine ?? 0) > 0,
        joinOpensAt: kind === "tournament" ? joinOpensAt(m.startsAt).toISOString() : null,
      });
    }
    return out;
  });

  /**
   * Games: any approved player may create a public or private game (two open at a time);
   * tournaments, the scheduled ranked kind, are the admin's. Private games get an invite code.
   */
  app.post("/api/matches", async (req, reply) => {
    const user = requireVerified(req);
    const body = createMatchBody.parse(req.body);
    const kind = body.kind ?? "public";
    if (kind === "tournament" && !devTools && !user.isAdmin) throw httpError(403, "only admins create tournaments");
    if (!user.isAdmin && !user.approved) throw httpError(403, "verify your email first; the code is in your inbox");
    if (!user.isAdmin && body.speed > balance.match.maxGameSpeed) throw httpError(400, `games run at ${balance.match.maxGameSpeed}x at most (about four hours); tournaments are 1x`);
    if (!user.isAdmin) {
      const [open] = await db.select({ n: sql<number>`count(*)::int` }).from(matches).where(and(inArray(matches.status, ["lobby", "running"]), sql`${matches.settings}->>'createdBy' = ${user.id}`));
      if ((open?.n ?? 0) >= 1) throw httpError(409, "you already have a game open; let it finish, or end it, before creating another");
    }
    const inviteCode = kind === "private" ? randomBytes(4).toString("hex").toUpperCase() : undefined;
    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date(Date.now() + body.startsInMinutes * 60_000);
    if (startsAt.getTime() < Date.now() - 60_000) throw httpError(400, "the start time is in the past");
    const endsAt = new Date(startsAt.getTime() + matchLengthSeconds(body.speed) * 1000);
    const slug = await uniqueSlug(db, body.name, startsAt);
    const [m] = await db
      .insert(matches)
      .values({
        name: body.name,
        slug,
        speed: body.speed,
        seed: randomBytes(8).toString("hex"),
        startsAt,
        endsAt,
        settings: {
          createdBy: user.id,
          ...(body.aiFillTo !== undefined ? { aiFillTo: body.aiFillTo } : {}),
          ...(body.neutralTribes !== undefined ? { neutralTribes: body.neutralTribes } : {}),
          ...(body.aiDifficulty ? { aiDifficulty: body.aiDifficulty } : {}),
          kind,
          ...(kind === "tournament" ? { weekly: true } : {}),
          ...(inviteCode ? { inviteCode } : {}),
        },
      })
      .returning();
    return reply.code(201).send({ id: m!.id, inviteCode: inviteCode ?? null });
  });

  /** A war-or-winter name no match has used, for the create form. */
  app.get("/api/matches/name-suggestion", async (req) => {
    const user = requireUser(req);
    if (!devTools && !user.isAdmin && !user.approved) throw httpError(403, "verify your email first; the code is in your inbox");
    const taken = new Set((await db.select({ name: matches.name }).from(matches)).map((r) => r.name.toLowerCase()));
    return { name: pickMatchName(taken, randomBytes(8).toString("hex")) };
  });

  /** Find a private game by its invite code, so the joiner can enter it from the lobby. */
  app.post("/api/matches/join-code", async (req) => {
    const user = requireVerified(req);
    if (!user.approved) throw httpError(403, "verify your email first; the code is in your inbox");
    const { code } = joinByCodeBody.parse(req.body);
    const [m] = await db.select({ id: matches.id, name: matches.name }).from(matches).where(and(eq(matches.status, "lobby"), sql`upper(${matches.settings}->>'inviteCode') = ${code.toUpperCase()}`)).limit(1);
    if (!m) throw httpError(404, "no open game has that invite code");
    return { id: m.id, name: m.name };
  });

  app.post("/api/matches/:id/join", async (req, reply) => {
    const user = requireVerified(req);
    const matchId = idParams.parse(req.params).id;
    const { inviteCode } = joinMatchBody.parse(req.body ?? {});
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (!user.approved) throw httpError(403, "verify your email first; the code is in your inbox");
    // A registered player who is not in a tournament that has already started comes in during its first days.
    if (m.status === "running" && isTournament(m.settings)) {
      const already = await myPlayer(matchId, user.id);
      if (already) return { playerId: already.id };
      const [reg] = await db.select({ id: tournamentRegistrations.id }).from(tournamentRegistrations).where(and(eq(tournamentRegistrations.matchId, matchId), eq(tournamentRegistrations.userId, user.id))).limit(1);
      if (reg && (await enrolRegistered(db, matchId, user.id)) > 0) {
        const p = await myPlayer(matchId, user.id);
        await publisher.toMatch(matchId, "player.joined", { name: user.displayName });
        return reply.code(201).send({ playerId: p!.id });
      }
      throw httpError(409, reg ? `the first ${balance.schedule.lateJoinDays} days have passed; the next tournament is open for registration` : "the match has already started");
    }
    if (m.status !== "lobby") throw httpError(409, "the match has already started");
    const s = (m.settings ?? {}) as { kind?: string; inviteCode?: string; createdBy?: string };
    if (s.kind === "private" && s.createdBy !== user.id && (inviteCode ?? "").toUpperCase() !== (s.inviteCode ?? "").toUpperCase()) throw httpError(403, "this is a private game: enter its invite code");
    // Tournaments: register any time, join once the lobby opens an hour before the start (admins may always join).
    if (isTournament(m.settings) && !user.isAdmin && !devTools && joinOpensAt(m.startsAt) > new Date()) throw httpError(409, `the lobby opens ${balance.schedule.joinOpensHours} hour${balance.schedule.joinOpensHours === 1 ? "" : "s"} before the start; register and we will remind you`);
    const existing = await myPlayer(matchId, user.id);
    if (existing) return { playerId: existing.id };
    const [humans] = await db.select({ n: sql`count(*)::int` }).from(players).where(and(eq(players.matchId, matchId), eq(players.isAi, false)));
    if (Number(humans?.n ?? 0) >= balance.match.maxHumanPlayers) throw httpError(409, "this match is full");
    const [p] = await db.insert(players).values({ matchId, userId: user.id, name: user.displayName }).returning();
    await publisher.toMatch(matchId, "player.joined", { name: user.displayName });
    return reply.code(201).send({ playerId: p!.id });
  });

  /** The creator of a game (not a tournament) may start it at once or call it off while it is still in the lobby. */
  async function creatorsLobbyGame(req: Parameters<typeof requireUser>[0]) {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    const s = (m.settings ?? {}) as { kind?: string; createdBy?: string };
    if (isTournament(m.settings)) throw httpError(400, "tournaments start on their schedule");
    if (s.createdBy !== user.id && !user.isAdmin) throw httpError(403, "only the game's creator can do that");
    if (m.status !== "lobby") throw httpError(409, "the game has already started");
    return { m, user };
  }

  app.post("/api/matches/:id/start-now", async (req) => {
    const { m } = await creatorsLobbyGame(req);
    // Move the start to now and start it; the scheduler would do the same within seconds.
    await db.update(matches).set({ startsAt: new Date() }).where(eq(matches.id, m.id));
    const started = await startMatch(db, publisher, m.id);
    if (!started) throw httpError(409, "the game could not be started");
    return { ok: true };
  });

  /** The creator (or an admin) ends a running game early: it finishes now with no winner, and its report stays. */
  app.post("/api/matches/:id/end", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    const s = (m.settings ?? {}) as { createdBy?: string };
    if (isTournament(m.settings)) throw httpError(400, "tournaments run to the end");
    if (s.createdBy !== user.id && !user.isAdmin) throw httpError(403, "only the game's creator can end it");
    if (m.status !== "running") throw httpError(409, m.status === "lobby" ? "the game has not started; cancel it instead" : "the game is already over");
    const after: Array<() => Promise<void>> = [];
    await db.transaction((tx) => finishMatch(tx, m, matchNow(m), publisher, (fn) => void after.push(fn), null, "ended"));
    for (const fn of after) await fn().catch(() => {});
    return { ok: true };
  });

  app.delete("/api/matches/:id", async (req) => {
    const { m } = await creatorsLobbyGame(req);
    await db.delete(matches).where(eq(matches.id, m.id));
    await publisher.toMatch(m.id, "match.cancelled", { name: m.name });
    return { ok: true };
  });

  app.get("/api/matches/:id/start-options", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    const p = await myPlayer(matchId, user.id);
    if (!p) throw httpError(403, "join the match first");
    const taken = (await takenCapitals(matchId)).filter((c) => c !== p.capitalRegionId);
    const options = startOptionsFor(m.seed, p.id, taken);
    return { options, current: p.capitalRegionId };
  });

  app.post("/api/matches/:id/pick-start", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const { regionId } = pickStartBody.parse(req.body);
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (m.status !== "lobby") throw httpError(409, "the match has already started");
    const p = await myPlayer(matchId, user.id);
    if (!p) throw httpError(403, "join the match first");
    if (!regionById(regionId)) throw httpError(400, "unknown region");
    const taken = (await takenCapitals(matchId)).filter((c) => c !== p.capitalRegionId);
    const options = startOptionsFor(m.seed, p.id, taken);
    if (!options.includes(regionId) || !farEnough(regionId, taken)) throw httpError(400, "that region is not available to you");
    await db.update(players).set({ capitalRegionId: regionId }).where(eq(players.id, p.id));
    return { ok: true };
  });

  app.get("/api/matches/:id/state", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    // Admins may look into any match from outside: everything in view, nothing to do.
    const view = await buildMatchState(db, matchId, user.id, { observer: user.isAdmin });
    if (!view) throw httpError(404, "you are not in that match");
    return view;
  });

  app.post("/api/matches/:id/regions/:regionId/assign", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = regionParams.parse(req.params);
    const shares = normalizeAssignment(assignBody.parse(req.body));
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (m.status !== "running") throw httpError(409, "the match is not running");
    if (m.pausedAt) throw httpError(409, "the match is paused");
    const p = await myPlayer(matchId, user.id);
    if (!p) throw httpError(403, "not your match");

    await db.transaction(async (tx) => {
      const row = await settleAndLockRegion(tx, matchId, regionId, matchNow(m), m.speed);
      if (row.ownerPlayerId !== p.id) throw httpError(403, "not your region");
      await tx
        .update(matchRegions)
        .set({ assignment: shares })
        .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId)));
    });
    await publisher.toPlayer(matchId, p.id, "region.updated", { regionId });
    return { ok: true, assignment: shares };
  });

  // -------------------------------------------------------------------------
  // Dev tools (DEV_TOOLS=true only; refused in production by config()).
  // -------------------------------------------------------------------------

  /** Pause: the match clock stops. Nothing completes, moves, produces or decides until resumed. */
  app.post("/api/matches/:id/pause", async (req) => {
    const user = requireUser(req);
    if (!devTools && !user.isAdmin) throw httpError(403, "admins only");
    const matchId = idParams.parse(req.params).id;
    const [m] = await db.update(matches).set({ pausedAt: sql`coalesce(${matches.pausedAt}, now())` }).where(and(eq(matches.id, matchId), eq(matches.status, "running"))).returning({ pausedAt: matches.pausedAt });
    if (!m) throw httpError(404, "no running match with that id");
    await publisher.toMatch(matchId, "match.paused", { pausedAt: m.pausedAt?.toISOString() });
    return { ok: true, pausedAt: m.pausedAt?.toISOString() ?? null };
  });

  /** Resume: every timestamp in the match moves forward by the time it was paused, so the game continues exactly where it stopped. */
  app.post("/api/matches/:id/resume", async (req) => {
    const user = requireUser(req);
    if (!devTools && !user.isAdmin) throw httpError(403, "admins only");
    const matchId = idParams.parse(req.params).id;
    const resumed = await db.transaction(async (tx) => {
      const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("no key update");
      if (!m || !m.pausedAt) return null;
      // postgres.js cannot bind a Date inside a raw fragment: pass the ISO text and cast it.
      const gap = sql`(now() - ${m.pausedAt.toISOString()}::timestamptz)`;
      await tx.execute(sql`update jobs set starts_at = starts_at + ${gap}, ends_at = ends_at + ${gap} where match_id = ${matchId} and completed_at is null and cancelled_at is null`);
      await tx.execute(sql`update armies set departs_at = departs_at + ${gap}, arrives_at = arrives_at + ${gap}, returns_at = returns_at + ${gap} where match_id = ${matchId} and status <> 'done'`);
      await tx.execute(sql`update trade_routes set next_at = next_at + ${gap} where match_id = ${matchId}`);
      await tx.execute(sql`update players set protection_until = protection_until + ${gap}, next_ai_at = next_ai_at + ${gap}, loyalty_boost_until = loyalty_boost_until + ${gap} where match_id = ${matchId}`);
      await tx.execute(sql`update match_regions set settled_at = settled_at + ${gap}, frozen_at = frozen_at + ${gap}, evacuated_at = evacuated_at + ${gap}, storm_until = storm_until + ${gap}, plague_until = plague_until + ${gap}, thaw_until = thaw_until + ${gap} where match_id = ${matchId}`);
      await tx.execute(sql`update pacts set "until" = "until" + ${gap} where match_id = ${matchId} and status in ('proposed', 'active', 'ending', 'refused')`);
      await tx.execute(sql`update refugee_offers set expires_at = expires_at + ${gap} where match_id = ${matchId} and decided_at is null`);
      await tx.execute(sql`update mercenary_offers set expires_at = expires_at + ${gap} where match_id = ${matchId} and hired_by is null`);
      await tx.execute(sql`update bounties set expires_at = expires_at + ${gap} where match_id = ${matchId} and claimed_by is null`);
      await tx.execute(sql`update matches set starts_at = starts_at + ${gap}, ends_at = ends_at + ${gap}, last_tick_at = last_tick_at + ${gap}, paused_at = null where id = ${matchId}`);
      return m.pausedAt;
    });
    if (!resumed) throw httpError(409, "that match is not paused");
    await publisher.toMatch(matchId, "match.resumed", {});
    return { ok: true, pausedFor: Math.round((Date.now() - resumed.getTime()) / 1000) };
  });

  app.post("/api/matches/:id/dev/start", async (req) => {
    const user = requireUser(req);
    if (!devTools && !user.isAdmin) throw httpError(404, "not found");
    const matchId = idParams.parse(req.params).id;
    const started = await startMatch(db, publisher, matchId);
    return { ok: true, started };
  });

  app.post("/api/matches/:id/dev/time-skip", async (req) => {
    requireUser(req);
    if (!devTools) throw httpError(404, "not found");
    const matchId = idParams.parse(req.params).id;
    const { seconds } = timeSkipBody.parse(req.body);
    const [m] = await db
      .update(matches)
      .set({ clockOffsetSeconds: sql`${matches.clockOffsetSeconds} + ${seconds}` })
      .where(eq(matches.id, matchId))
      .returning({ offset: matches.clockOffsetSeconds });
    if (!m) throw httpError(404, "match not found");
    await publisher.toMatch(matchId, "time.skipped", { seconds, clockOffsetSeconds: m.offset });
    return { ok: true, clockOffsetSeconds: m.offset };
  });
}
