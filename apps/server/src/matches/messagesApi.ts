import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { battles, matches, messages, players, regionNotes } from "../db/schema.js";
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
    const [mine] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, user.id))).limit(1);
    if (!mine && user.isAdmin) return { unread: 0, messages: [] };
    const p = mine ?? (await myPlayer(matchId, user.id));
    const rows = await db.select().from(messages).where(eq(messages.playerId, p.id)).orderBy(desc(messages.createdAt)).limit(100);
    await linkBattles(matchId, rows);
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

  /**
   * A battle report written before reports carried the battle's id is matched to its battle by region and time, so
   * every conquest and defeat in the inbox opens its replay, however old.
   */
  async function linkBattles(matchId: string, rows: Array<{ kind: string; payload: unknown; createdAt: Date }>): Promise<void> {
    const bare = rows.filter((r) => r.kind === "battle" && (r.payload as { report?: unknown }).report && !(r.payload as { battleId?: unknown }).battleId && typeof (r.payload as { regionId?: unknown }).regionId === "string");
    if (!bare.length) return;
    const regionIds = [...new Set(bare.map((r) => (r.payload as { regionId: string }).regionId))];
    const fights = await db
      .select({ id: battles.id, regionId: battles.regionId, resolvedAt: battles.resolvedAt, startedAt: battles.startedAt })
      .from(battles)
      .where(and(eq(battles.matchId, matchId), inArray(battles.regionId, regionIds)));
    // Messages are stamped in real time; battles on the match clock, which a time skip moves ahead of it.
    const [m] = await db.select({ offset: matches.clockOffsetSeconds }).from(matches).where(eq(matches.id, matchId)).limit(1);
    const offsetMs = (m?.offset ?? 0) * 1000;
    const window = 30 * 60_000;
    for (const r of bare) {
      const p = r.payload as { regionId: string; battleId?: string };
      const at = r.createdAt.getTime() + offsetMs;
      // The report is written as the last round ends, a little after the battle began: the nearest start before it wins.
      let best: { id: string; gap: number } | null = null;
      for (const f of fights) {
        if (f.regionId !== p.regionId) continue;
        const began = (f.startedAt ?? f.resolvedAt).getTime();
        const gap = at - began;
        if (gap < -60_000 || gap > window) continue;
        if (!best || Math.abs(gap) < best.gap) best = { id: f.id, gap: Math.abs(gap) };
      }
      if (best) r.payload = { ...p, battleId: best.id };
    }
  }

  app.post("/api/matches/:id/messages/read", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const [mine] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, user.id))).limit(1);
    if (!mine && user.isAdmin) return { ok: true };
    const p = mine ?? (await myPlayer(matchId, user.id));
    await db.update(messages).set({ readAt: new Date() }).where(and(eq(messages.playerId, p.id), isNull(messages.readAt)));
    return { ok: true };
  });
}
