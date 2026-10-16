import type { FastifyInstance } from "fastify";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { changePasswordBody, forgotBody, loginBody, registerBody, resetBody, updateProfileBody, verifyBody, type UserView } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { config } from "../config.js";
import type { Redis } from "ioredis";
import type { Publisher } from "../realtime/publish.js";
import { emailTokens, sessions, users, players, matches } from "../db/schema.js";
import { hashPassword, hashToken, newToken, verifyPassword } from "./password.js";
import { createSession, destroySession, requireUser } from "./session.js";
import { resetMail, sendMail, verificationMail } from "../mail.js";

const VERIFY_HOURS = 24;
const RESET_HOURS = 1;

function toView(u: {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: Date | null;
  isAdmin: boolean;
  approvedAt?: Date | null;
  canRename?: boolean;
  tagline?: string | null;
  bio?: string | null;
  location?: string | null;
  createdAt?: Date;
}): UserView {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    emailVerified: u.emailVerifiedAt !== null,
    isAdmin: u.isAdmin,
    approved: u.isAdmin || !!u.approvedAt || config().DEV_TOOLS,
    canRename: u.canRename ?? false,
    tagline: u.tagline ?? null,
    bio: u.bio ?? null,
    location: u.location ?? null,
    createdAt: u.createdAt?.toISOString() ?? null,
  };
}

export async function issueToken(db: Db, userId: string, kind: "verify" | "reset", hours: number): Promise<string> {
  const { token, hash } = newToken();
  await db.insert(emailTokens).values({ userId, kind, tokenHash: hash, expiresAt: new Date(Date.now() + hours * 3600_000) });
  return token;
}

/** A real argon2 hash, verified against when the email is unknown, so a missing account takes as long as a wrong password. */
const DUMMY_HASH_PROMISE = hashPassword("not-a-real-password-" + Math.random());

export async function authRoutes(app: FastifyInstance, opts: { db: Db; redis: Redis; publisher: Publisher }) {
  const { db, redis, publisher } = opts;
  const tight = (max: number, timeWindow: string) => ({ config: { rateLimit: { max, timeWindow } } });
  /** One mail per address per ten minutes for resend and forgot, whatever the caller does. */
  const mailAllowed = async (kind: string, email: string) => (await redis.set(`lt-mail:${kind}:${email}`, "1", "EX", 600, "NX")) === "OK";

  app.post("/api/auth/register", tight(10, "10 minutes"), async (req, reply) => {
    const body = registerBody.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) return reply.code(409).send({ error: "an account with that email already exists" });
    const nameTaken = await db.select({ id: users.id }).from(users).where(sql`lower(${users.displayName}) = ${body.displayName.toLowerCase()}`).limit(1);
    if (nameTaken.length) return reply.code(409).send({ error: "that tribe name is taken; pick another" });

    const [u] = await db
      .insert(users)
      .values({ email, displayName: body.displayName, passwordHash: await hashPassword(body.password) })
      .returning();
    if (!u) throw new Error("insert failed");

    const token = await issueToken(db, u.id, "verify", VERIFY_HOURS);
    const mail = verificationMail(u.displayName, token);
    void sendMail(u.email, mail.subject, mail.text, mail.html);

    await createSession(db, req, reply, u.id);
    return reply.code(201).send(toView(u));
  });

  app.post("/api/auth/login", tight(20, "1 minute"), async (req, reply) => {
    const body = loginBody.parse(req.body);
    const email = body.email.trim().toLowerCase();
    // Ten wrong passwords in fifteen minutes locks the account for the rest of the window.
    const failKey = `lt-login-fail:${email}`;
    const fails = Number((await redis.get(failKey)) ?? 0);
    if (fails >= 10) return reply.code(429).send({ error: "too many attempts; try again in 15 minutes" });
    const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const ok = u ? await verifyPassword(u.passwordHash, body.password) : await verifyPassword(await DUMMY_HASH_PROMISE, body.password);
    if (!u || !ok) {
      await redis.multi().incr(failKey).expire(failKey, 900).exec();
      return reply.code(401).send({ error: "wrong email or password" });
    }
    if (u.suspendedAt) return reply.code(403).send({ error: "this account is suspended" });
    await redis.del(failKey);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
    await createSession(db, req, reply, u.id);
    return toView(u);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const userId = req.user?.id;
    await destroySession(db, req, reply);
    if (userId) await publisher.sessionsEnded(userId);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "not logged in" });
    return req.user;
  });

  app.post("/api/auth/verify", tight(10, "10 minutes"), async (req, reply) => {
    const { token } = verifyBody.parse(req.body);
    const now = new Date();
    const [row] = await db
      .select()
      .from(emailTokens)
      .where(and(eq(emailTokens.tokenHash, hashToken(token)), eq(emailTokens.kind, "verify"), isNull(emailTokens.usedAt), gt(emailTokens.expiresAt, now)))
      .limit(1);
    if (!row) return reply.code(400).send({ error: "that link is invalid or expired" });
    await db.transaction(async (tx) => {
      await tx.update(emailTokens).set({ usedAt: now }).where(eq(emailTokens.id, row.id));
      await tx.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, row.userId));
    });
    return { ok: true };
  });

  app.post("/api/auth/resend-verification", tight(5, "10 minutes"), async (req, reply) => {
    const user = requireUser(req);
    if (user.emailVerified) return { ok: true };
    if (!(await mailAllowed("verify", user.email))) return { ok: true };
    const token = await issueToken(db, user.id, "verify", VERIFY_HOURS);
    const mail = verificationMail(user.displayName, token);
    void sendMail(user.email, mail.subject, mail.text, mail.html);
    return reply.send({ ok: true });
  });

  /** Profile settings: the free-text details a player writes about themselves. The tribe name is fixed at signup. */
  app.patch("/api/me/profile", tight(30, "10 minutes"), async (req, reply) => {
    const user = requireUser(req);
    const body = updateProfileBody.parse(req.body);
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.tagline !== undefined) patch.tagline = body.tagline;
    if (body.bio !== undefined) patch.bio = body.bio;
    if (body.location !== undefined) patch.location = body.location;
    if (body.displayName !== undefined && body.displayName !== user.displayName) {
      if (!user.canRename) return reply.code(409).send({ error: "your tribe name is fixed" });
      const [taken] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.displayName}) = ${body.displayName.toLowerCase()}`).limit(1);
      if (taken) return reply.code(409).send({ error: "that tribe name is taken" });
      patch.displayName = body.displayName;
      patch.canRename = false;
    }
    const [u] = Object.keys(patch).length
      ? await db.update(users).set(patch).where(eq(users.id, user.id)).returning()
      : await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!u) return reply.code(404).send({ error: "account not found" });
    if (patch.displayName) await db.update(players).set({ name: patch.displayName }).where(and(eq(players.userId, u.id), sql`exists (select 1 from matches mm where mm.id = ${players.matchId} and mm.status <> 'finished')`));
    return toView(u);
  });

  /** Change password while logged in. Every other session is ended; this one stays. */
  app.post("/api/me/password", tight(10, "10 minutes"), async (req, reply) => {
    const user = requireUser(req);
    const { currentPassword, newPassword } = changePasswordBody.parse(req.body);
    const [u] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!u || !(await verifyPassword(u.passwordHash, currentPassword))) return reply.code(400).send({ error: "current password is wrong" });
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, u.id));
      if (req.sessionId) await tx.delete(sessions).where(and(eq(sessions.userId, u.id), sql`${sessions.id} <> ${req.sessionId}`));
    });
    return { ok: true };
  });

  app.post("/api/auth/forgot", tight(5, "10 minutes"), async (req) => {
    const { email } = forgotBody.parse(req.body);
    const [u] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
    if (u && (await mailAllowed("reset", u.email))) {
      const token = await issueToken(db, u.id, "reset", RESET_HOURS);
      const mail = resetMail(u.displayName, token);
      void sendMail(u.email, mail.subject, mail.text, mail.html);
    }
    // Always succeed so the endpoint cannot be used to probe for accounts.
    return { ok: true };
  });

  app.post("/api/auth/reset", tight(10, "10 minutes"), async (req, reply) => {
    const { token, password } = resetBody.parse(req.body);
    const now = new Date();
    const [row] = await db
      .select()
      .from(emailTokens)
      .where(and(eq(emailTokens.tokenHash, hashToken(token)), eq(emailTokens.kind, "reset"), isNull(emailTokens.usedAt), gt(emailTokens.expiresAt, now)))
      .limit(1);
    if (!row) return reply.code(400).send({ error: "that link is invalid or expired" });
    await db.transaction(async (tx) => {
      await tx.update(emailTokens).set({ usedAt: now }).where(eq(emailTokens.id, row.id));
      // The link reached the inbox, so the address is verified too (invited accounts never saw a verification mail).
      await tx.update(users).set({ passwordHash: await hashPassword(password), emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now.toISOString()}::timestamptz)` }).where(eq(users.id, row.userId));
      await tx.delete(sessions).where(eq(sessions.userId, row.userId));
    });
    await publisher.sessionsEnded(row.userId);
    return { ok: true };
  });
}
