import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { and, eq } from "drizzle-orm";
import { wsClientMessage, type WsServerMessage } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { players } from "../db/schema.js";
import { channels, type PublishedEvent } from "../realtime/publish.js";
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
    send(socket, { type: "hello", serverTime: new Date().toISOString() });

    socket.on("message", async (data) => {
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
      for (const ch of mine) void unsubscribe(socket, ch);
    });
    socket.on("error", (err) => logger.warn({ err }, "websocket error"));
  });

  app.addHook("onClose", async () => {
    await subscriber.quit();
  });
}
