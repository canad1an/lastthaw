import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messages, players, regionNotes } from "../db/schema.js";
import { regionById, regionNoteBody } from "@lastthaw/shared";
import { z } from "zod";
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

  // Private notes on a region: a marker colour and some text, seen only by their author. Not a game command.
  app.put("/api/matches/:id/notes/:regionId", async (req) => {
    const user = requireUser(req);
    const { id: matchId, regionId } = z.object({ id: z.string(), regionId: z.string() }).parse(req.params);
    if (!regionById(regionId)) throw httpError(404, "no such region");
    const body = regionNoteBody.parse(req.body ?? {});
    const p = await myPlayer(matchId, user.id);
    const text = body.text.trim();
    if (!text && !body.colour) {
      await db.delete(regionNotes).where(and(eq(regionNotes.matchId, matchId), eq(regionNotes.playerId, p.id), eq(regionNotes.regionId, regionId)));
      return { ok: true, note: null };
    }
    const [row] = await db
      .insert(regionNotes)
      .values({ matchId, playerId: p.id, regionId, text, colour: body.colour, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [regionNotes.matchId, regionNotes.playerId, regionNotes.regionId], set: { text, colour: body.colour, updatedAt: new Date() } })
      .returning();
    return { ok: true, note: { regionId, text: row!.text, colour: row!.colour, updatedAt: row!.updatedAt.toISOString() } };
  });

  app.post("/api/matches/:id/messages/read", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const p = await myPlayer(matchId, user.id);
    await db.update(messages).set({ readAt: new Date() }).where(and(eq(messages.playerId, p.id), isNull(messages.readAt)));
    return { ok: true };
  });
}
