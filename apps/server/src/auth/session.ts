import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { config } from "../config.js";

export const SESSION_COOKIE = "lt_session";
const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
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
    const rows = await opts.db
      .select({
        sessionId: sessions.id,
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, unsigned.value), gt(sessions.expiresAt, new Date())))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    req.sessionId = row.sessionId;
    req.user = { id: row.id, email: row.email, displayName: row.displayName, emailVerified: row.emailVerifiedAt !== null };
  });
});

export async function createSession(db: Db, req: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  const [row] = await db
    .insert(sessions)
    .values({ userId, expiresAt, ip: req.ip, userAgent: req.headers["user-agent"] ?? null })
    .returning({ id: sessions.id });
  if (!row) throw new Error("failed to create session");
  reply.setCookie(SESSION_COOKIE, row.id, {
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

/** Route guard: 403 unless the email is verified. */
export function requireVerified(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (!u.emailVerified) throw Object.assign(new Error("verify your email first"), { statusCode: 403 });
  return u;
}
