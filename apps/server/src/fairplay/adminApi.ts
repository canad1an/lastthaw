import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { fairplayFlags, matchRegions, matches, players, sessions, users } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { eliminatePlayer } from "../sim/missions.js";
import { matchNow } from "../sim/clock.js";
import { requireAdmin } from "../auth/session.js";
import { detectMultiAccounts } from "./detect.js";
import { idParams } from "../matches/params.js";

const verdictBody = z.object({ verdict: z.enum(["cleared", "warned", "confirmed"]) });
const suspendBody = z.object({ reason: z.string().trim().min(2).max(200) });
const kickParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

/** Admin-only review queue for multi-account flags, plus a few match controls. */
export async function adminRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

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
    const names = ids.length ? await db.select({ id: users.id, email: users.email, displayName: users.displayName, suspendedAt: users.suspendedAt }).from(users).where(sql`${users.id} = any(${ids})`) : [];
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
    const created = await detectMultiAccounts(db);
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
