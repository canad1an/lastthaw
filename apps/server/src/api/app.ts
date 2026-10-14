import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import type { HealthResponse } from "@lastthaw/shared";
import { config } from "../config.js";
import { logger } from "../logger.js";

export const VERSION = "0.0.1";

export async function buildApp() {
  const cfg = config();
  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  await app.register(cors, { origin: cfg.PUBLIC_URL, credentials: true });
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  await app.register(websocket);

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    serverTime: new Date().toISOString(),
    version: VERSION,
  }));

  // Placeholder realtime channel. M1 replaces this with per-player subscriptions fed by Redis.
  app.get("/api/ws", { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: "hello", serverTime: new Date().toISOString() }));
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "tick", serverTime: new Date().toISOString() }));
      }
    }, 10_000);
    socket.on("close", () => clearInterval(ping));
  });

  return app;
}
