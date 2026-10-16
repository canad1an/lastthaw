import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { and, eq } from "drizzle-orm";
import { wsClientMessage, type WsServerMessage } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { players } from "../db/schema.js";
import { channels, type PublishedEvent } from "../realtime/publish.js";
import { hostname } from "node:os";
import { createRedis } from "../redis.js";
import { logger } from "../logger.js";

/**
 * WebSocket hub. One Redis subscriber per API process fans events out to the
 * sockets subscribed to each channel. A socket may subscribe to a match only
 * if the logged-in user has a player in it.
 */
export async function registerWebsocket(app: FastifyInstance, opts: { db: Db }) {
  const subscriber = createRedis();
  await subscriber.connect();
  const sockets = new Map<string, Set<WebSocket>>(); // channel -> sockets
  const byUser = new Map<string, Set<WebSocket>>(); // user id -> sockets, so a logout can close them
  const presence = new Map<WebSocket, { userId: string | null; mine: Set<string> }>(); // every open socket, for the admin's online view
  await subscriber.subscribe(channels.auth);

  // Presence: each API process writes who is connected (and which match each is watching) to a short-lived
  // Redis key, so the admin page can add the processes up. Written every 15 seconds, gone 45 seconds after the process.
  const presenceWriter = createRedis();
  const presenceKey = `lt-presence:${hostname()}:${process.pid}`;
  const writePresence = async () => {
    const users: Record<string, string[]> = {};
    let anonymous = 0;
    for (const { userId, mine } of presence.values()) {
      if (!userId) {
        anonymous += 1;
        continue;
      }
      const matchIds = [...mine].filter((ch) => ch.startsWith("match:")).map((ch) => ch.slice("match:".length));
      users[userId] = [...new Set([...(users[userId] ?? []), ...matchIds])];
    }
    await presenceWriter.set(presenceKey, JSON.stringify({ at: new Date().toISOString(), sockets: presence.size, anonymous, users }), "EX", 45).catch(() => {});
  };
  const presenceTimer = setInterval(() => void writePresence(), 15_000);

  const send = (ws: WebSocket, msg: WsServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const subscribe = async (ws: WebSocket, channel: string) => {
    let set = sockets.get(channel);
    if (!set) {
      set = new Set();
      sockets.set(channel, set);
      await subscriber.subscribe(channel);
    }
    set.add(ws);
  };

  const unsubscribe = async (ws: WebSocket, channel: string) => {
    const set = sockets.get(channel);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      sockets.delete(channel);
      await subscriber.unsubscribe(channel);
    }
  };

  subscriber.on("message", (channel: string, raw: string) => {
    if (channel === channels.auth) {
      try {
        const { userId } = JSON.parse(raw) as { userId: string };
        for (const ws of byUser.get(userId) ?? []) ws.close(4001, "logged out");
      } catch {
        /* ignore */
      }
      return;
    }
    const set = sockets.get(channel);
    if (!set) return;
    let ev: PublishedEvent;
    try {
      ev = JSON.parse(raw) as PublishedEvent;
    } catch {
      return;
    }
    for (const ws of set) send(ws, { type: "event", matchId: ev.matchId, kind: ev.kind, at: ev.at, payload: ev.payload });
  });

  app.get("/api/ws", { websocket: true }, (socket, req) => {
    const user = req.user;
    const mine = new Set<string>();
    if (user) (byUser.get(user.id) ?? byUser.set(user.id, new Set()).get(user.id)!).add(socket);
    presence.set(socket, { userId: user?.id ?? null, mine });
    send(socket, { type: "hello", serverTime: new Date().toISOString() });

    // Ten messages a second is plenty for pings and subscriptions; more is a client gone wrong.
    let windowStart = Date.now();
    let inWindow = 0;
    socket.on("message", async (data) => {
      const t = Date.now();
      if (t - windowStart > 1000) {
        windowStart = t;
        inWindow = 0;
      }
      if (++inWindow > 10) return socket.close(4002, "too many messages");
      let msg;
      try {
        msg = wsClientMessage.parse(JSON.parse(String(data)));
      } catch {
        return send(socket, { type: "error", message: "bad message" });
      }
      if (msg.type === "ping") return send(socket, { type: "pong", serverTime: new Date().toISOString() });
      if (!user) return send(socket, { type: "error", message: "login required" });

      if (msg.type === "subscribe") {
        const [p] = await opts.db
          .select({ id: players.id })
          .from(players)
          .where(and(eq(players.matchId, msg.matchId), eq(players.userId, user.id)))
          .limit(1);
        if (!p) return send(socket, { type: "error", message: "not a player in that match" });
        for (const ch of [channels.match(msg.matchId), channels.player(p.id)]) {
          mine.add(ch);
          await subscribe(socket, ch);
        }
        return send(socket, { type: "subscribed", matchId: msg.matchId });
      }
      if (msg.type === "unsubscribe") {
        for (const ch of [...mine]) {
          if (ch === channels.match(msg.matchId) || ch.startsWith("player:")) {
            mine.delete(ch);
            await unsubscribe(socket, ch);
          }
        }
      }
    });

    socket.on("close", () => {
      presence.delete(socket);
      for (const ch of mine) void unsubscribe(socket, ch);
      if (user) {
        const set = byUser.get(user.id);
        set?.delete(socket);
        if (set && set.size === 0) byUser.delete(user.id);
      }
    });
    socket.on("error", (err) => logger.warn({ err }, "websocket error"));
  });

  app.addHook("onClose", async () => {
    clearInterval(presenceTimer);
    await presenceWriter.del(presenceKey).catch(() => {});
    await presenceWriter.quit().catch(() => {});
    await subscriber.quit();
  });
}
