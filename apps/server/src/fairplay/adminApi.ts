import type { FastifyInstance } from "fastify";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { fairplayFlags, matches, users } from "../db/schema.js";
import { requireAdmin } from "../auth/session.js";
import { detectMultiAccounts } from "./detect.js";

const verdictBody = z.object({ verdict: z.enum(["cleared", "warned", "confirmed"]) });

/** Admin-only review queue for multi-account flags, plus a few match controls. */
export async function adminRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

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
    const names = ids.length ? await db.select({ id: users.id, email: users.email, displayName: users.displayName }).from(users).where(sql`${users.id} = any(${ids})`) : [];
    const nameBy = new Map(names.map((n) => [n.id, n]));
    return {
      flags: rows.map((r) => ({
        id: r.f.id,
        reason: r.f.reason,
        score: r.f.score,
        evidence: r.f.evidence,
        createdAt: r.f.createdAt.toISOString(),
        match: r.matchName,
        userA: nameBy.get(r.f.userA) ?? { id: r.f.userA },
        userB: nameBy.get(r.f.userB) ?? { id: r.f.userB },
      })),
    };
  });

  app.post("/api/admin/fairplay/:id/review", async (req) => {
    const admin = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const { verdict } = verdictBody.parse(req.body);
    await db.update(fairplayFlags).set({ reviewedAt: new Date(), reviewedBy: admin.id, verdict }).where(eq(fairplayFlags.id, id));
    return { ok: true };
  });

  app.post("/api/admin/fairplay/scan", async (req) => {
    requireAdmin(req);
    const created = await detectMultiAccounts(db);
    return { ok: true, created };
  });

  app.get("/api/admin/matches", async (req) => {
    requireAdmin(req);
    const rows = await db.select().from(matches).orderBy(desc(matches.createdAt)).limit(50);
    return rows.map((m) => ({ id: m.id, name: m.name, status: m.status, speed: m.speed, startsAt: m.startsAt, endsAt: m.endsAt, settings: m.settings }));
  });
}
