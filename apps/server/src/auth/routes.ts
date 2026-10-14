import type { FastifyInstance } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { forgotBody, loginBody, registerBody, resetBody, verifyBody, type UserView } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { emailTokens, sessions, users } from "../db/schema.js";
import { hashPassword, hashToken, newToken, verifyPassword } from "./password.js";
import { createSession, destroySession, requireUser } from "./session.js";
import { resetMail, sendMail, verificationMail } from "../mail.js";

const VERIFY_HOURS = 24;
const RESET_HOURS = 1;

function toView(u: { id: string; email: string; displayName: string; emailVerifiedAt: Date | null; isAdmin: boolean }): UserView {
  return { id: u.id, email: u.email, displayName: u.displayName, emailVerified: u.emailVerifiedAt !== null, isAdmin: u.isAdmin };
}

async function issueToken(db: Db, userId: string, kind: "verify" | "reset", hours: number): Promise<string> {
  const { token, hash } = newToken();
  await db.insert(emailTokens).values({ userId, kind, tokenHash: hash, expiresAt: new Date(Date.now() + hours * 3600_000) });
  return token;
}

export async function authRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.post("/api/auth/register", async (req, reply) => {
    const body = registerBody.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) return reply.code(409).send({ error: "an account with that email already exists" });

    const [u] = await db
      .insert(users)
      .values({ email, displayName: body.displayName, passwordHash: await hashPassword(body.password) })
      .returning();
    if (!u) throw new Error("insert failed");

    const token = await issueToken(db, u.id, "verify", VERIFY_HOURS);
    const mail = verificationMail(u.displayName, token);
    void sendMail(u.email, mail.subject, mail.text);

    await createSession(db, req, reply, u.id);
    return reply.code(201).send(toView(u));
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = loginBody.parse(req.body);
    const email = body.email.trim().toLowerCase();
    const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!u || !(await verifyPassword(u.passwordHash, body.password))) {
      return reply.code(401).send({ error: "wrong email or password" });
    }
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
    await createSession(db, req, reply, u.id);
    return toView(u);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await destroySession(db, req, reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "not logged in" });
    return req.user;
  });

  app.post("/api/auth/verify", async (req, reply) => {
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

  app.post("/api/auth/resend-verification", async (req, reply) => {
    const user = requireUser(req);
    if (user.emailVerified) return { ok: true };
    const token = await issueToken(db, user.id, "verify", VERIFY_HOURS);
    const mail = verificationMail(user.displayName, token);
    void sendMail(user.email, mail.subject, mail.text);
    return reply.send({ ok: true });
  });

  app.post("/api/auth/forgot", async (req) => {
    const { email } = forgotBody.parse(req.body);
    const [u] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
    if (u) {
      const token = await issueToken(db, u.id, "reset", RESET_HOURS);
      const mail = resetMail(u.displayName, token);
      void sendMail(u.email, mail.subject, mail.text);
    }
    // Always succeed so the endpoint cannot be used to probe for accounts.
    return { ok: true };
  });

  app.post("/api/auth/reset", async (req, reply) => {
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
      await tx.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, row.userId));
      await tx.delete(sessions).where(eq(sessions.userId, row.userId));
    });
    return { ok: true };
  });
}
