import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messages, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import { idParams } from "./params.js";

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode: status });
}

/** The in-game message center: battle reports, scout reports, finished builds, trades. */
export async function messageRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  async function myPlayer(matchId: string, userId: string) {
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
      .limit(1);
    if (!p) throw httpError(403, "not your match");
    return p;
  }

  app.get("/api/matches/:id/messages", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const p = await myPlayer(matchId, user.id);
    const rows = await db.select().from(messages).where(eq(messages.playerId, p.id)).orderBy(desc(messages.createdAt)).limit(100);
    const [unread] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.playerId, p.id), isNull(messages.readAt)));
    return {
      unread: unread?.n ?? 0,
      messages: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        subject: r.subject,
        payload: r.payload,
        readAt: r.readAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.post("/api/matches/:id/messages/read", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const p = await myPlayer(matchId, user.id);
    await db.update(messages).set({ readAt: new Date() }).where(and(eq(messages.playerId, p.id), isNull(messages.readAt)));
    return { ok: true };
  });
}
