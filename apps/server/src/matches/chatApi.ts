import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { chatChannel, chatPostBody, type ChatResponse } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import type { Redis } from "ioredis";
import { allianceMembers, chatMessages, lobbyMessages, matches, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { httpError } from "../sim/commands.js";
import { idParams } from "./params.js";

/** Minimum gap between two chat posts from one player. */
const RATE_LIMIT_MS = 1000;

/** Global and alliance chat. Messages are stored per match in `chat_messages`. */
export async function chatRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher; redis: Redis }) {
  const { db, publisher } = opts;

  async function myPlayer(matchId: string, userId: string) {
    const [m] = await db.select({ id: matches.id }).from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
      .limit(1);
    if (!p) throw httpError(403, "not your match");
    return p;
  }

  /** Resolve the stored channel name; alliance chat needs membership. Returns the member ids for alliance chat. */
  async function resolveChannel(playerId: string, channel: "global" | "alliance"): Promise<{ stored: string; members: string[] | null }> {
    if (channel === "global") return { stored: "global", members: null };
    const [mine] = await db.select({ allianceId: allianceMembers.allianceId }).from(allianceMembers).where(eq(allianceMembers.playerId, playerId)).limit(1);
    if (!mine) throw httpError(403, "you are not in an alliance");
    const rows = await db.select({ playerId: allianceMembers.playerId }).from(allianceMembers).where(eq(allianceMembers.allianceId, mine.allianceId));
    return { stored: `alliance:${mine.allianceId}`, members: rows.map((r) => r.playerId) };
  }

  /** The lobby room: anyone logged in reads it, approved players write to it. */
  app.get("/api/chat/lobby", async (req) => {
    requireUser(req);
    const rows = await db.select().from(lobbyMessages).orderBy(desc(lobbyMessages.sentAt)).limit(100);
    return { messages: rows.reverse().map((r) => ({ id: r.id, userId: r.userId, name: r.name, body: r.body, sentAt: r.sentAt.toISOString() })) };
  });

  app.post("/api/chat/lobby", async (req, reply) => {
    const user = requireUser(req);
    if (!user.approved) throw httpError(403, "Last Thaw is in private beta: ask Matt for access first");
    const body = chatPostBody.shape.body.parse((req.body as { body?: unknown })?.body);
    if ((await opts.redis.set(`lt-chat:lobby:${user.id}`, "1", "PX", RATE_LIMIT_MS, "NX")) !== "OK") throw httpError(409, "slow down: one message per second");
    const [row] = await db.insert(lobbyMessages).values({ userId: user.id, name: user.displayName, body }).returning();
    if (!row) throw new Error("lobby chat insert failed");
    return reply.code(201).send({ id: row.id, userId: row.userId, name: row.name, body: row.body, sentAt: row.sentAt.toISOString() });
  });

  app.get("/api/matches/:id/chat", async (req): Promise<ChatResponse> => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const q = req.query as { channel?: string };
    const channel = chatChannel.parse(q.channel ?? "global");
    const p = await myPlayer(matchId, user.id);
    const { stored } = await resolveChannel(p.id, channel);
    const rows = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.matchId, matchId), eq(chatMessages.channel, stored)))
      .orderBy(desc(chatMessages.sentAt))
      .limit(100);
    return {
      channel,
      messages: rows.reverse().map((r) => ({ id: r.id, channel, playerId: r.playerId, playerName: r.playerName, body: r.body, sentAt: r.sentAt.toISOString() })),
    };
  });

  app.post("/api/matches/:id/chat", async (req, reply) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const body = chatPostBody.parse(req.body);
    const p = await myPlayer(matchId, user.id);
    const { stored, members } = await resolveChannel(p.id, body.channel);

    // One message a second per player, counted in Redis so both API replicas agree.
    if ((await opts.redis.set(`lt-chat:${p.id}`, "1", "PX", RATE_LIMIT_MS, "NX")) !== "OK") throw httpError(409, "slow down: one message per second");

    const [row] = await db.insert(chatMessages).values({ matchId, channel: stored, playerId: p.id, playerName: p.name, body: body.body }).returning();
    if (!row) throw new Error("chat insert failed");
    const payload = { channel: body.channel, id: row.id, playerId: p.id, playerName: row.playerName, body: row.body, sentAt: row.sentAt.toISOString() };
    if (members) for (const id of members) await publisher.toPlayer(matchId, id, "chat.message", payload);
    else await publisher.toMatch(matchId, "chat.message", payload);
    return reply.code(201).send(payload);
  });
}
