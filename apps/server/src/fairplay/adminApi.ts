import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { fairplayFlags, jobs, matchRegions, matches, players, sessions, tournamentRegistrations, users } from "../db/schema.js";
import { isTournament, joinOpensAt } from "../matches/registrations.js";
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

    // The ten most recently started matches that are in play, newest first: no lobbies waiting to start, no finished games.
    const matchRows = await db.select().from(matches).where(eq(matches.status, "running")).orderBy(desc(matches.startsAt)).limit(10);
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
            startsAt: m.startsAt.toISOString(),
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

  /** Every account, newest first: who they are, when they signed up, and whether the email is verified. */
  app.get("/api/admin/users", async (req) => {
    requireAdmin(req);
    const rows = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName, createdAt: users.createdAt, emailVerifiedAt: users.emailVerifiedAt, suspendedAt: users.suspendedAt, lastLoginAt: users.lastLoginAt, isAdmin: users.isAdmin, isModerator: users.isModerator })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(500);
    return { users: rows.map((u) => ({ ...u, createdAt: u.createdAt.toISOString(), emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null, suspendedAt: u.suspendedAt?.toISOString() ?? null, lastLoginAt: u.lastLoginAt?.toISOString() ?? null })) };
  });

  /**
   * Everything tracked per account, for the admin page only: time online, sessions, logins, devices and browsers,
   * hours of the day, matches and results, commands, chat, battles, techs, peak score.
   */
  app.get("/api/admin/player-stats", async (req) => {
    requireAdmin(req);
    const rows = await db.execute(sql`
      with results as (
        select r.user_id,
          count(*)::int as played,
          count(*) filter (where r.ranked)::int as ranked,
          count(*) filter (where r.won)::int as wins,
          count(*) filter (where not r.won and r.eliminated_at is not null)::int as eliminated,
          coalesce(sum(r.score), 0)::int as points,
          min(r.final_rank)::int as best_rank,
          round(avg(r.final_rank), 1)::float as avg_rank
        from user_match_results r group by r.user_id
      ),
      acts as (select user_id, count(*)::int as commands, max(at) as last_command_at from player_actions group by user_id),
      chats as (select p.user_id, count(*)::int as messages from chat_messages c join players p on p.id = c.player_id where p.user_id is not null group by p.user_id),
      fights as (
        select p.user_id,
          count(*)::int as battles,
          count(*) filter (where (b.attacker_player_id = p.id and (b.report->>'attackerWon')::boolean) or (b.defender_player_id = p.id and not (b.report->>'attackerWon')::boolean))::int as won
        from battles b join players p on p.id = b.attacker_player_id or p.id = b.defender_player_id
        where p.user_id is not null group by p.user_id
      ),
      techs as (select p.user_id, count(*)::int as techs from player_techs t join players p on p.id = t.player_id where p.user_id is not null group by p.user_id),
      peak as (select user_id, max(score)::int as peak_score, max(age)::int as top_age, count(*)::int as tribes from players where user_id is not null group by user_id)
      select u.id, u.display_name as name, u.email, u.created_at, u.last_login_at, u.is_admin, u.approved_at is not null as approved, u.suspended_at is not null as suspended,
        coalesce(s.seconds_online, 0)::int as seconds_online, coalesce(s.longest_session_seconds, 0)::int as longest_session, coalesce(s.sessions, 0)::int as sessions, coalesce(s.logins, 0)::int as logins,
        coalesce(s.devices, '{}'::jsonb) as devices, coalesce(s.hours, '{}'::jsonb) as hours, s.last_seen_at,
        coalesce(r.played, 0) as played, coalesce(r.ranked, 0) as ranked, coalesce(r.wins, 0) as wins, coalesce(r.eliminated, 0) as eliminated, coalesce(r.points, 0) as points, r.best_rank, r.avg_rank,
        coalesce(a.commands, 0) as commands, a.last_command_at, coalesce(c.messages, 0) as messages, coalesce(f.battles, 0) as battles, coalesce(f.won, 0) as battles_won,
        coalesce(t.techs, 0) as techs, coalesce(k.peak_score, 0) as peak_score, coalesce(k.top_age, 0) as top_age, coalesce(k.tribes, 0) as tribes
      from users u
      left join user_stats s on s.user_id = u.id
      left join results r on r.user_id = u.id
      left join acts a on a.user_id = u.id
      left join chats c on c.user_id = u.id
      left join fights f on f.user_id = u.id
      left join techs t on t.user_id = u.id
      left join peak k on k.user_id = u.id
      order by coalesce(s.seconds_online, 0) desc, u.created_at desc
      limit 500`);
    const list = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
    return {
      players: (list as Array<Record<string, unknown>>).map((r) => {
        const devices = Object.entries((r.devices as Record<string, number>) ?? {}).sort((a, b) => b[1] - a[1]);
        const hours = Object.entries((r.hours as Record<string, number>) ?? {}).sort((a, b) => b[1] - a[1]);
        const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);
        return {
          id: r.id,
          name: r.name,
          email: r.email,
          isAdmin: !!r.is_admin,
          approved: !!r.approved,
          suspended: !!r.suspended,
          createdAt: toIso(r.created_at),
          lastLoginAt: toIso(r.last_login_at),
          lastSeenAt: toIso(r.last_seen_at),
          lastCommandAt: toIso(r.last_command_at),
          hoursOnline: Math.round((Number(r.seconds_online) / 3600) * 10) / 10,
          longestSessionMinutes: Math.round(Number(r.longest_session) / 60),
          sessions: Number(r.sessions),
          logins: Number(r.logins),
          topDevice: devices[0]?.[0] ?? null,
          devices: devices.slice(0, 4).map(([key, n]) => ({ key, n: Number(n) })),
          activeHoursUtc: hours.slice(0, 3).map(([h, n]) => ({ hour: Number(h), n: Number(n) })),
          played: Number(r.played),
          ranked: Number(r.ranked),
          wins: Number(r.wins),
          eliminated: Number(r.eliminated),
          points: Number(r.points),
          bestRank: r.best_rank === null ? null : Number(r.best_rank),
          avgRank: r.avg_rank === null ? null : Number(r.avg_rank),
          commands: Number(r.commands),
          messages: Number(r.messages),
          battles: Number(r.battles),
          battlesWon: Number(r.battles_won),
          techs: Number(r.techs),
          peakScore: Number(r.peak_score),
          topAge: Number(r.top_age),
          tribes: Number(r.tribes),
        };
      }),
    };
  });

  /**
   * Upcoming tournaments and who has registered for each: name, email, when they registered, which reminders went out,
   * and whether they have since joined the lobby. Tournaments that started in the last day stay listed so the turnout
   * can be read against the sign-ups.
   */
  app.get("/api/admin/tournaments", async (req) => {
    requireAdmin(req);
    const since = new Date(Date.now() - 24 * 3600_000);
    const all = await db.select().from(matches).where(gt(matches.startsAt, since)).orderBy(matches.startsAt);
    const tournaments = all.filter((m) => isTournament(m.settings));
    if (tournaments.length === 0) return { tournaments: [] };
    const ids = tournaments.map((m) => m.id);
    const regs = await db
      .select({ matchId: tournamentRegistrations.matchId, userId: tournamentRegistrations.userId, createdAt: tournamentRegistrations.createdAt, remindedDayAt: tournamentRegistrations.remindedDayAt, remindedHourAt: tournamentRegistrations.remindedHourAt, name: users.displayName, email: users.email })
      .from(tournamentRegistrations)
      .innerJoin(users, eq(users.id, tournamentRegistrations.userId))
      .where(inArray(tournamentRegistrations.matchId, ids))
      .orderBy(tournamentRegistrations.createdAt);
    const joined = await db.select({ matchId: players.matchId, userId: players.userId }).from(players).where(and(inArray(players.matchId, ids), isNull(players.eliminatedAt)));
    const joinedKey = new Set(joined.map((p) => `${p.matchId}:${p.userId}`));
    return {
      tournaments: tournaments.map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        startsAt: m.startsAt.toISOString(),
        lobbyOpensAt: joinOpensAt(m.startsAt).toISOString(),
        speed: m.speed,
        joined: joined.filter((p) => p.matchId === m.id).length,
        registrations: regs
          .filter((r) => r.matchId === m.id)
          .map((r) => ({ userId: r.userId, name: r.name, email: r.email, registeredAt: r.createdAt.toISOString(), remindedDay: !!r.remindedDayAt, remindedHour: !!r.remindedHourAt, joined: joinedKey.has(`${m.id}:${r.userId}`) })),
      })),
    };
  });

  app.get("/api/admin/matches", async (req) => {
    requireAdmin(req);
    const rows = await db.select().from(matches).orderBy(desc(matches.createdAt)).limit(50);
    return rows.map((m) => ({ id: m.id, name: m.name, status: m.status, speed: m.speed, startsAt: m.startsAt, endsAt: m.endsAt, settings: m.settings }));
  });
}
