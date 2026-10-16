import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { fairplayFlags, jobs, matchRegions, matches, players, sessions, users } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { eliminatePlayer } from "../sim/missions.js";
import { matchNow } from "../sim/clock.js";
import { requireAdmin } from "../auth/session.js";
import { detectAutomation, detectMultiAccounts } from "./detect.js";
import { idParams } from "../matches/params.js";

const verdictBody = z.object({ verdict: z.enum(["cleared", "warned", "confirmed"]) });
const suspendBody = z.object({ reason: z.string().trim().min(2).max(200) });
const kickParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

/** Admin-only review queue for multi-account flags, plus a few match controls. */
export async function adminRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher; redis?: Redis }) {
  const { db, publisher, redis } = opts;

  /**
   * Live metrics for the admin page: who is connected right now (from the API
   * processes' presence keys), who was active in the last quarter hour, the
   * account funnel, every running match with its humans and worker health,
   * the job backlog and the last day's activity.
   */
  app.get("/api/admin/metrics", async (req) => {
    requireAdmin(req);
    const now = new Date();
    const m15 = new Date(now.getTime() - 15 * 60_000);
    const h24 = new Date(now.getTime() - 24 * 3600_000);
    const d7 = new Date(now.getTime() - 7 * 86400_000);
    const h1 = new Date(now.getTime() - 3600_000);

    // Connected sockets across every API process.
    const presence = { sockets: 0, anonymous: 0, users: {} as Record<string, string[]>, processes: 0 };
    if (redis) {
      const keys = await redis.keys("lt-presence:*").catch(() => [] as string[]);
      for (const key of keys) {
        const raw = await redis.get(key).catch(() => null);
        if (!raw) continue;
        try {
          const p = JSON.parse(raw) as { sockets: number; anonymous: number; users: Record<string, string[]> };
          presence.processes += 1;
          presence.sockets += p.sockets;
          presence.anonymous += p.anonymous;
          for (const [uid, ms] of Object.entries(p.users)) presence.users[uid] = [...new Set([...(presence.users[uid] ?? []), ...ms])];
        } catch {
          /* a stale key */
        }
      }
    }
    const onlineIds = Object.keys(presence.users);

    const [funnel] = await db
      .select({
        total: sql<number>`count(*)::int`,
        verified: sql<number>`count(*) filter (where ${users.emailVerifiedAt} is not null)::int`,
        approved: sql<number>`count(*) filter (where ${users.approvedAt} is not null)::int`,
        suspended: sql<number>`count(*) filter (where ${users.suspendedAt} is not null)::int`,
        new24h: sql<number>`count(*) filter (where ${users.createdAt} > ${h24.toISOString()}::timestamptz)::int`,
        new7d: sql<number>`count(*) filter (where ${users.createdAt} > ${d7.toISOString()}::timestamptz)::int`,
        loggedIn24h: sql<number>`count(*) filter (where ${users.lastLoginAt} > ${h24.toISOString()}::timestamptz)::int`,
        loggedIn7d: sql<number>`count(*) filter (where ${users.lastLoginAt} > ${d7.toISOString()}::timestamptz)::int`,
      })
      .from(users);
    // Active in the last quarter hour: any session touched since then.
    const active = await db
      .select({ id: users.id, name: users.displayName, lastSeenAt: sql<string>`max(${sessions.lastSeenAt})` })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(gt(sessions.lastSeenAt, m15))
      .groupBy(users.id, users.displayName)
      .orderBy(desc(sql`max(${sessions.lastSeenAt})`))
      .limit(100);
    const onlineRows = onlineIds.length ? await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, onlineIds)) : [];

    const matchRows = await db.select().from(matches).where(inArray(matches.status, ["lobby", "running"])).orderBy(desc(matches.startsAt));
    const matchIds = matchRows.map((m) => m.id);
    const nameOfMatch = new Map(matchRows.map((m) => [m.id, m.name]));
    const playerCounts = matchIds.length
      ? await db
          .select({ matchId: players.matchId, humans: sql<number>`count(*) filter (where ${players.userId} is not null and ${players.eliminatedAt} is null)::int`, ai: sql<number>`count(*) filter (where ${players.isAi} and not ${players.hidden})::int` })
          .from(players)
          .where(inArray(players.matchId, matchIds))
          .groupBy(players.matchId)
      : [];
    const jobCounts = matchIds.length
      ? await db
          .select({
            matchId: jobs.matchId,
            open: sql<number>`count(*) filter (where ${jobs.completedAt} is null and ${jobs.cancelledAt} is null)::int`,
            due: sql<number>`count(*) filter (where ${jobs.completedAt} is null and ${jobs.cancelledAt} is null and ${jobs.waitingFor} is null and ${jobs.endsAt} <= now() - interval '60 seconds')::int`,
            parked: sql<number>`count(*) filter (where ${jobs.completedAt} is null and ${jobs.cancelledAt} is null and ${jobs.attempts} >= 5)::int`,
            doneHour: sql<number>`count(*) filter (where ${jobs.completedAt} > ${h1.toISOString()}::timestamptz)::int`,
          })
          .from(jobs)
          .where(inArray(jobs.matchId, matchIds))
          .groupBy(jobs.matchId)
      : [];
    const pc = new Map(playerCounts.map((r) => [r.matchId, r]));
    const jc = new Map(jobCounts.map((r) => [r.matchId, r]));
    const [finished] = await db.select({ n: sql<number>`count(*)::int`, day: sql<number>`count(*) filter (where ${matches.finishedAt} > ${h24.toISOString()}::timestamptz)::int` }).from(matches).where(eq(matches.status, "finished"));
    // The processes: each writes a heartbeat to Redis; a stale or missing one is an alarm. Lobbies past their start time mean the scheduler is not running.
    const beat = async (key: string) => {
      const raw = redis ? await redis.get(key).catch(() => null) : null;
      return raw ? Math.round((now.getTime() - Date.parse(raw)) / 1000) : null;
    };
    const processes = { workerBeatSeconds: await beat("lt-heartbeat:worker"), aiBeatSeconds: await beat("lt-heartbeat:ai"), lobbiesOverdue: matchRows.filter((m) => m.status === "lobby" && m.startsAt.getTime() < now.getTime() - 60_000).length };
    const actRows = (await db.execute(
      sql`select (select count(*) from battles where resolved_at > ${h24.toISOString()}::timestamptz)::int as "battles24h",
                 (select count(*) from chat_messages where sent_at > ${h24.toISOString()}::timestamptz)::int as "chat24h",
                 (select count(*) from events where at > ${h24.toISOString()}::timestamptz)::int as "events24h",
                 (select count(*) from sessions where created_at > ${d7.toISOString()}::timestamptz)::int as "sessions7d"`,
    )) as unknown as Array<{ battles24h: number; chat24h: number; events24h: number; sessions7d: number }>;
    const activity = actRows[0];

    return {
      at: now.toISOString(),
      online: {
        users: onlineRows.map((u) => ({ id: u.id, name: u.name, matches: (presence.users[u.id] ?? []).map((id) => nameOfMatch.get(id) ?? "a match") })),
        sockets: presence.sockets,
        anonymous: presence.anonymous,
        processes: presence.processes,
      },
      active15m: active.map((a) => ({ id: a.id, name: a.name, lastSeenAt: a.lastSeenAt })),
      users: funnel,
      matches: {
        finished: finished?.n ?? 0,
        finished24h: finished?.day ?? 0,
        open: matchRows.map((m) => {
          const mnow = matchNow(m);
          const day = m.status === "running" ? Math.round(((mnow.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed * 10) / 10 : 0;
          return {
            id: m.id,
            name: m.name,
            status: m.status,
            speed: m.speed,
            kind: ((m.settings as { kind?: string }).kind ?? "public") as string,
            day,
            humans: pc.get(m.id)?.humans ?? 0,
            ai: pc.get(m.id)?.ai ?? 0,
            online: onlineIds.filter((uid) => (presence.users[uid] ?? []).includes(m.id)).length,
            lastTickAgeSeconds: m.lastTickAt ? Math.round((mnow.getTime() - m.lastTickAt.getTime()) / 1000) : null,
            paused: !!m.pausedAt,
            jobs: { open: jc.get(m.id)?.open ?? 0, due: jc.get(m.id)?.due ?? 0, parked: jc.get(m.id)?.parked ?? 0, doneHour: jc.get(m.id)?.doneHour ?? 0 },
          };
        }),
      },
      activity: activity ?? { battles24h: 0, chat24h: 0, events24h: 0, sessions7d: 0 },
      processes,
    };
  });

  app.get("/api/admin/fairplay", async (req) => {
    requireAdmin(req);
    const rows = await db
      .select({ f: fairplayFlags, matchName: matches.name })
      .from(fairplayFlags)
      .leftJoin(matches, eq(matches.id, fairplayFlags.matchId))
      .where(isNull(fairplayFlags.reviewedAt))
      .orderBy(desc(fairplayFlags.score), desc(fairplayFlags.createdAt))
      .limit(200);
    const ids = [...new Set(rows.flatMap((r) => [r.f.userA, r.f.userB]))];
    const names = ids.length ? await db.select({ id: users.id, email: users.email, displayName: users.displayName, suspendedAt: users.suspendedAt }).from(users).where(inArray(users.id, ids)) : [];
    const nameBy = new Map(names.map((n) => [n.id, n]));
    return {
      flags: rows.map((r) => ({
        id: r.f.id,
        reason: r.f.reason,
        score: r.f.score,
        evidence: r.f.evidence,
        createdAt: r.f.createdAt.toISOString(),
        match: r.matchName,
        matchId: r.f.matchId,
        userA: nameBy.get(r.f.userA) ?? { id: r.f.userA },
        userB: nameBy.get(r.f.userB) ?? { id: r.f.userB },
      })),
    };
  });

  app.post("/api/admin/fairplay/:id/review", async (req) => {
    const admin = requireAdmin(req);
    const id = idParams.parse(req.params).id;
    const { verdict } = verdictBody.parse(req.body);
    const updated = await db.update(fairplayFlags).set({ reviewedAt: new Date(), reviewedBy: admin.id, verdict }).where(eq(fairplayFlags.id, id)).returning({ id: fairplayFlags.id });
    if (updated.length === 0) throw Object.assign(new Error("no such flag"), { statusCode: 404 });
    return { ok: true };
  });

  app.post("/api/admin/fairplay/scan", async (req) => {
    requireAdmin(req);
    const created = (await detectMultiAccounts(db)) + (await detectAutomation(db));
    return { ok: true, created };
  });

  /** Suspend an account: sessions end everywhere, login is refused until cleared. Logged on the user row. */
  app.post("/api/admin/users/:id/suspend", async (req) => {
    const admin = requireAdmin(req);
    const id = idParams.parse(req.params).id;
    const { reason } = suspendBody.parse(req.body);
    const [u] = await db.update(users).set({ suspendedAt: new Date(), suspendReason: `${reason} (by ${admin.email})` }).where(eq(users.id, id)).returning({ id: users.id });
    if (!u) throw Object.assign(new Error("no such user"), { statusCode: 404 });
    await db.delete(sessions).where(eq(sessions.userId, id));
    await publisher.sessionsEnded(id);
    return { ok: true };
  });

  app.post("/api/admin/users/:id/unsuspend", async (req) => {
    requireAdmin(req);
    const id = idParams.parse(req.params).id;
    await db.update(users).set({ suspendedAt: null, suspendReason: null }).where(eq(users.id, id));
    return { ok: true };
  });

  /** Kick a user's player out of a running match: their regions go neutral and they are eliminated. */
  app.post("/api/admin/matches/:id/kick/:userId", async (req) => {
    const admin = requireAdmin(req);
    const { id: matchId, userId } = kickParams.parse(req.params);
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m || m.status !== "running") throw Object.assign(new Error("no running match with that id"), { statusCode: 404 });
    const [p] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, userId))).limit(1);
    if (!p || p.eliminatedAt) throw Object.assign(new Error("no active player for that user"), { statusCode: 404 });
    await db.transaction(async (tx) => {
      await tx.update(matchRegions).set({ ownerPlayerId: null, popOccupiers: 0, isCapital: false }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.ownerPlayerId, p.id)));
      await eliminatePlayer(tx, m, p.id, matchNow(m), `removed by an admin (${admin.email})`);
    });
    await publisher.toMatch(matchId, "match.started", { kicked: p.id });
    return { ok: true };
  });

  /** Beta access: every account, newest first, with approve and revoke. */
  app.get("/api/admin/users", async (req) => {
    requireAdmin(req);
    const rows = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName, createdAt: users.createdAt, emailVerifiedAt: users.emailVerifiedAt, approvedAt: users.approvedAt, suspendedAt: users.suspendedAt, lastLoginAt: users.lastLoginAt })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(500);
    return { users: rows.map((u) => ({ ...u, createdAt: u.createdAt.toISOString(), emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null, approvedAt: u.approvedAt?.toISOString() ?? null, suspendedAt: u.suspendedAt?.toISOString() ?? null, lastLoginAt: u.lastLoginAt?.toISOString() ?? null })) };
  });

  app.post("/api/admin/users/:id/approve", async (req) => {
    requireAdmin(req);
    const id = idParams.parse(req.params).id;
    await db.update(users).set({ approvedAt: new Date() }).where(eq(users.id, id));
    return { ok: true };
  });

  app.post("/api/admin/users/:id/revoke", async (req) => {
    requireAdmin(req);
    const id = idParams.parse(req.params).id;
    await db.update(users).set({ approvedAt: null }).where(eq(users.id, id));
    return { ok: true };
  });

  app.get("/api/admin/matches", async (req) => {
    requireAdmin(req);
    const rows = await db.select().from(matches).orderBy(desc(matches.createdAt)).limit(50);
    return rows.map((m) => ({ id: m.id, name: m.name, status: m.status, speed: m.speed, startsAt: m.startsAt, endsAt: m.endsAt, settings: m.settings }));
  });
}
