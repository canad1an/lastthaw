import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  assignBody,
  balance,
  createMatchBody,
  normalizeAssignment,
  pickStartBody,
  regionById,
  timeSkipBody,
  type MatchSummary,
} from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matchRegions, matches, players } from "../db/schema.js";
import { requireUser, requireVerified } from "../auth/session.js";
import { config } from "../config.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { settleAndLockRegion } from "../sim/regions.js";
import { buildMatchState } from "../view/matchState.js";
import { startMatch, matchLengthSeconds } from "./start.js";
import { farEnough, startOptionsFor } from "./startOptions.js";

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
          .select({ matchId: players.matchId, n: sql<number>`count(*) filter (where not is_ai)::int` })
          .from(players)
          .where(inArray(players.matchId, ids))
          .groupBy(players.matchId)
      : [];
    const countBy = new Map(counts.map((c) => [c.matchId, c.n]));
    const mine = user
      ? await db
          .select({ matchId: players.matchId, id: players.id, capital: players.capitalRegionId })
          .from(players)
          .where(and(eq(players.userId, user.id), ids.length ? inArray(players.matchId, ids) : sql`false`))
      : [];
    const mineBy = new Map(mine.map((p) => [p.matchId, p]));
    const out: MatchSummary[] = rows.map((m) => {
      const mp = mineBy.get(m.id);
      return {
        id: m.id,
        name: m.name,
        status: m.status,
        speed: m.speed,
        startsAt: m.startsAt.toISOString(),
        endsAt: m.endsAt.toISOString(),
        humanPlayers: countBy.get(m.id) ?? 0,
        maxPlayers: balance.match.maxHumanPlayers,
        joined: !!mp,
        playerId: mp?.id ?? null,
        capitalRegionId: mp?.capital ?? null,
      };
    });
    return out;
  });

  // Hand-made matches: admins in production, anyone verified when dev tools are on.
  app.post("/api/matches", async (req, reply) => {
    const user = requireVerified(req);
    if (!devTools && !user.isAdmin) throw httpError(403, "only admins can create matches; the weekly match is created automatically");
    const body = createMatchBody.parse(req.body);
    const startsAt = new Date(Date.now() + body.startsInMinutes * 60_000);
    const endsAt = new Date(startsAt.getTime() + matchLengthSeconds(body.speed) * 1000);
    const [m] = await db
      .insert(matches)
      .values({
        name: body.name,
        speed: body.speed,
        seed: randomBytes(8).toString("hex"),
        startsAt,
        endsAt,
        settings: {
          createdBy: user.id,
          ...(body.aiFillTo !== undefined ? { aiFillTo: body.aiFillTo } : {}),
          ...(body.neutralTribes !== undefined ? { neutralTribes: body.neutralTribes } : {}),
          ...(body.aiDifficulty ? { aiDifficulty: body.aiDifficulty } : {}),
        },
      })
      .returning();
    return reply.code(201).send({ id: m!.id });
  });

  app.post("/api/matches/:id/join", async (req, reply) => {
    const user = requireVerified(req);
    const matchId = (req.params as { id: string }).id;
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (m.status !== "lobby") throw httpError(409, "the match has already started");
    const existing = await myPlayer(matchId, user.id);
    if (existing) return { playerId: existing.id };
    const [p] = await db.insert(players).values({ matchId, userId: user.id, name: user.displayName }).returning();
    await publisher.toMatch(matchId, "player.joined", { name: user.displayName });
    return reply.code(201).send({ playerId: p!.id });
  });

  app.get("/api/matches/:id/start-options", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
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
    const matchId = (req.params as { id: string }).id;
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
    const matchId = (req.params as { id: string }).id;
    const view = await buildMatchState(db, matchId, user.id);
    if (!view) throw httpError(404, "you are not in that match");
    return view;
  });

  app.post("/api/matches/:id/regions/:regionId/assign", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = req.params as { id: string; regionId: string };
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
    const matchId = (req.params as { id: string }).id;
    const [m] = await db.update(matches).set({ pausedAt: sql`coalesce(${matches.pausedAt}, now())` }).where(and(eq(matches.id, matchId), eq(matches.status, "running"))).returning({ pausedAt: matches.pausedAt });
    if (!m) throw httpError(404, "no running match with that id");
    await publisher.toMatch(matchId, "match.paused", { pausedAt: m.pausedAt?.toISOString() });
    return { ok: true, pausedAt: m.pausedAt?.toISOString() ?? null };
  });

  /** Resume: every timestamp in the match moves forward by the time it was paused, so the game continues exactly where it stopped. */
  app.post("/api/matches/:id/resume", async (req) => {
    const user = requireUser(req);
    if (!devTools && !user.isAdmin) throw httpError(403, "admins only");
    const matchId = (req.params as { id: string }).id;
    const resumed = await db.transaction(async (tx) => {
      const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("no key update");
      if (!m || !m.pausedAt) return null;
      const gap = sql`(now() - ${m.pausedAt})`;
      await tx.execute(sql`update jobs set starts_at = starts_at + ${gap}, ends_at = ends_at + ${gap} where match_id = ${matchId} and completed_at is null and cancelled_at is null`);
      await tx.execute(sql`update armies set departs_at = departs_at + ${gap}, arrives_at = arrives_at + ${gap}, returns_at = returns_at + ${gap} where match_id = ${matchId} and status <> 'done'`);
      await tx.execute(sql`update trade_routes set next_at = next_at + ${gap} where match_id = ${matchId}`);
      await tx.execute(sql`update players set protection_until = protection_until + ${gap}, next_ai_at = next_ai_at + ${gap} where match_id = ${matchId}`);
      await tx.execute(sql`update match_regions set settled_at = settled_at + ${gap}, frozen_at = frozen_at + ${gap}, evacuated_at = evacuated_at + ${gap} where match_id = ${matchId}`);
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
    const matchId = (req.params as { id: string }).id;
    const started = await startMatch(db, publisher, matchId);
    return { ok: true, started };
  });

  app.post("/api/matches/:id/dev/time-skip", async (req) => {
    requireUser(req);
    if (!devTools) throw httpError(404, "not found");
    const matchId = (req.params as { id: string }).id;
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
