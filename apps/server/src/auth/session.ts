import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { emailTokens, sessionSightings, sessions, users } from "../db/schema.js";
import { config } from "../config.js";
import { hashToken, newToken } from "./password.js";

export const SESSION_COOKIE = "lt_session";
/** A random id the server sets once per browser; the client cannot pick it, so two accounts on one browser share it. */
export const DEVICE_COOKIE = "lt_device";
const SESSION_DAYS = 30;
/** A session nobody has used for this long is over, whatever its hard expiry. */
const IDLE_DAYS = 7;
const TOUCH_MS = 10 * 60_000;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  isAdmin: boolean;
  /** May join and create: a verified email (an admin's approval also counts). */
  approved: boolean;
  canRename: boolean;
  tagline: string | null;
  bio: string | null;
  location: string | null;
  createdAt: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionId: string | null;
  }
}

/** Reads the signed session cookie on every request and attaches the user, if any. */
export const sessionPlugin = fp(async (app: FastifyInstance, opts: { db: Db }) => {
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);

  app.addHook("onRequest", async (req) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const now = new Date();
    const idleCutoff = new Date(now.getTime() - IDLE_DAYS * 86400_000);
    const rows = await opts.db
      .select({
        sessionId: sessions.id,
        lastSeenAt: sessions.lastSeenAt,
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        emailVerifiedAt: users.emailVerifiedAt,
        isAdmin: users.isAdmin,
        approvedAt: users.approvedAt,
        canRename: users.canRename,
        tagline: users.tagline,
        bio: users.bio,
        location: users.location,
        createdAt: users.createdAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashToken(unsigned.value)), gt(sessions.expiresAt, now), or(sql`${sessions.lastSeenAt} is null`, gt(sessions.lastSeenAt, idleCutoff)), sql`${users.suspendedAt} is null`))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    // Touch at most every ten minutes, so the idle clock costs one write per session per ten minutes; the same pass records where the session was seen this hour.
    if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > TOUCH_MS) {
      const hour = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);
      void opts.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId)).catch(() => {});
      void opts.db
        .insert(sessionSightings)
        .values({ sessionId: row.sessionId, userId: row.id, hour, ip: req.ip, userAgent: (req.headers["user-agent"] ?? "").slice(0, 200) || null })
        .onConflictDoNothing()
        .catch(() => {});
    }
    req.sessionId = row.sessionId;
    req.user = { id: row.id, email: row.email, displayName: row.displayName, emailVerified: row.emailVerifiedAt !== null, isAdmin: row.isAdmin, approved: row.isAdmin || row.emailVerifiedAt !== null || config().DEV_TOOLS, canRename: row.canRename, tagline: row.tagline, bio: row.bio, location: row.location, createdAt: row.createdAt.toISOString() };
  });
});

export async function createSession(db: Db, req: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  // The device id is a cookie the server set; a header the client made up is not trusted.
  let device = req.cookies[DEVICE_COOKIE];
  const signedDevice = device ? req.unsignCookie(device) : null;
  device = signedDevice?.valid && signedDevice.value ? signedDevice.value : undefined;
  if (!device) {
    device = newToken().hash.slice(0, 32);
    reply.setCookie(DEVICE_COOKIE, device, { path: "/", httpOnly: true, sameSite: "lax", secure: config().NODE_ENV === "production", signed: true, maxAge: 365 * 86400 });
  }
  const { token, hash } = newToken();
  const [row] = await db
    .insert(sessions)
    .values({ userId, expiresAt, tokenHash: hash, lastSeenAt: new Date(), ip: req.ip, userAgent: req.headers["user-agent"] ?? null, fingerprint: device })
    .returning({ id: sessions.id });
  if (!row) throw new Error("failed to create session");
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config().NODE_ENV === "production",
    signed: true,
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function destroySession(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.sessionId) await db.delete(sessions).where(eq(sessions.id, req.sessionId));
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Route guard: 401 unless logged in. */
export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw Object.assign(new Error("login required"), { statusCode: 401 });
  return req.user;
}

/** Route guard: 404 (not 403, to avoid revealing the route) unless the user is an admin. */
export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (!u.isAdmin) throw Object.assign(new Error("not found"), { statusCode: 404 });
  return u;
}

/** Route guard: 403 unless the email is verified. */
export function requireVerified(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (!u.emailVerified) throw Object.assign(new Error("verify your email first"), { statusCode: 403 });
  return u;
}

/** Drop sessions that expired or went idle, and email tokens that are used or expired. Run from the worker. */
export async function cleanupSessions(db: Db): Promise<{ sessions: number; tokens: number }> {
  const now = new Date();
  const idleCutoff = new Date(now.getTime() - IDLE_DAYS * 86400_000);
  const s = await db.delete(sessions).where(or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, idleCutoff), sql`${sessions.tokenHash} is null`)).returning({ id: sessions.id });
  const dayAgo = new Date(now.getTime() - 86400_000);
  const t = await db.delete(emailTokens).where(or(lt(emailTokens.expiresAt, dayAgo), lt(emailTokens.usedAt, dayAgo))).returning({ id: emailTokens.id });
  return { sessions: s.length, tokens: t.length };
}
