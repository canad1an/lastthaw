import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import rateLimit from "@fastify/rate-limit";
import type { HealthResponse } from "@lastthaw/shared";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { createDb, type Db } from "../db/client.js";
import { createRedis } from "../redis.js";
import { Publisher } from "../realtime/publish.js";
import { sessionPlugin } from "../auth/session.js";
import { authRoutes } from "../auth/routes.js";
import { matchRoutes } from "../matches/routes.js";
import { jobRoutes } from "../matches/jobsApi.js";
import { armyRoutes } from "../matches/armiesApi.js";
import { messageRoutes } from "../matches/messagesApi.js";
import { allianceRoutes } from "../matches/alliancesApi.js";
import { chatRoutes } from "../matches/chatApi.js";
import { marketRoutes } from "../matches/marketApi.js";
import { leaderboardRoutes } from "../matches/leaderboardApi.js";
import { feedRoutes } from "../matches/feedApi.js";
import { eventRoutes } from "../matches/eventsApi.js";
import { adminRoutes } from "../fairplay/adminApi.js";
import { publicRoutes } from "../matches/publicApi.js";
import { tradeRouteRoutes } from "../matches/tradeApi.js";
import { registerWebsocket } from "./ws.js";

export const VERSION = "0.1.0";

export interface AppDeps {
  db?: Db;
  /** Skip Redis-backed realtime (unit tests). */
  realtime?: boolean;
}

export async function buildApp(deps: AppDeps = {}) {
  const cfg = config();
  const db = deps.db ?? createDb();
  const redis = createRedis();
  const publisher = new Publisher(redis);

  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "invalid request", issues: err.issues });
    }
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error({ err }, "request failed");
    return reply.code(status).send({ error: status >= 500 ? "internal error" : (e.message ?? "error") });
  });

  await app.register(cors, { origin: cfg.PUBLIC_URL, credentials: true });
  // Every client gets 300 requests a minute per address; the auth routes set much lower limits of their own.
  // Counters live in Redis so both API replicas share them.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute", redis, nameSpace: "lt-rl:", keyGenerator: (req) => req.ip, skipOnError: true });
  // Cross-site writes are refused outright: browsers always send Origin on cross-site POSTs.
  const allowedOrigins = new Set([cfg.PUBLIC_URL, cfg.PUBLIC_URL.replace("://", "://www.")]);
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: "cross-site request refused" });
  });
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  await app.register(sessionPlugin, { db });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    serverTime: new Date().toISOString(),
    version: VERSION,
    devTools: cfg.DEV_TOOLS,
  }));

  await app.register(authRoutes, { db, redis, publisher });
  await app.register(matchRoutes, { db, publisher });
  await app.register(jobRoutes, { db, publisher });
  await app.register(armyRoutes, { db, publisher });
  await app.register(messageRoutes, { db });
  await app.register(allianceRoutes, { db, publisher });
  await app.register(chatRoutes, { db, publisher, redis });
  await app.register(marketRoutes, { db, publisher });
  await app.register(leaderboardRoutes, { db });
  await app.register(adminRoutes, { db, publisher });
  await app.register(publicRoutes, { db });
  await app.register(tradeRouteRoutes, { db, publisher });
  await app.register(feedRoutes, { db });
  await app.register(eventRoutes, { db, publisher });
  if (deps.realtime !== false) await app.register(registerWebsocket, { db });

  app.addHook("onClose", async () => {
    await redis.quit().catch(() => {});
    if (!deps.db) await db.close();
  });

  return app;
}
