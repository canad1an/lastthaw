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
import { eventRoutes, diplomacyRoutes } from "../matches/eventsApi.js";
import { advisorRoutes } from "../matches/advisorsApi.js";
import { battleRoutes } from "../matches/battlesApi.js";
import { adminRoutes } from "../fairplay/adminApi.js";
import { registrationRoutes } from "../matches/registrations.js";
import { resolveMatchRef } from "../matches/slug.js";
import { playerActions } from "../db/schema.js";
import { balance } from "@lastthaw/shared";

/** The routes that move the game: everything under a match except reading, chat and the inbox. */
const COMMAND_PATH = /^\/api\/matches\/[^/]+\/(regions\/|research$|armies\/|rally$|capital$|market|routes\/|pacts|refugees\/|mercenaries\/|last-stand$|jobs\/)/;
function isCommand(method: string, url: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && COMMAND_PATH.test(url.split("?")[0]!);
}
import { publicRoutes } from "../matches/publicApi.js";
import { matchPageRoutes } from "../matches/pageHtml.js";
import { tradeRouteRoutes } from "../matches/tradeApi.js";
import { registerWebsocket } from "./ws.js";
import { clientErrorRoutes } from "./clientErrors.js";

/** 0.<commits on main>, baked into the image at build time; "0.dev" when run from source. */
export const VERSION = process.env.APP_VERSION ?? "0.dev";

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

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      // The site's own pages never send a body the server refuses, so this is a UI bug (or a hand-made request); the nightly run reads these.
      app.log.warn({ invalidRequest: true, method: req.method, url: req.url.split("?")[0], issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, "invalid request body");
      return reply.code(400).send({ error: "invalid request", issues: err.issues });
    }
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error({ err }, "request failed");
    // With dev tools on (local and test runs) the message rides along; production says only that it failed.
    return reply.code(status).send({ error: status >= 500 ? "internal error" : (e.message ?? "error"), ...(status >= 500 && cfg.NODE_ENV !== "production" ? { detail: e.message } : {}) });
  });

  await app.register(cors, { origin: cfg.PUBLIC_URL, credentials: true });
  // Every client gets 300 requests a minute per address; the auth routes set much lower limits of their own.
  // Counters live in Redis so both API replicas share them.
  await app.register(rateLimit, { global: true, max: cfg.LOAD_TEST ? 1_000_000 : 300, timeWindow: "1 minute", redis, nameSpace: "lt-rl:", keyGenerator: (req) => req.ip, skipOnError: true });
  // Cross-site writes are refused outright: browsers always send Origin on cross-site POSTs.
  const allowedOrigins = new Set([cfg.PUBLIC_URL, cfg.PUBLIC_URL.replace("://", "://www.")]);
  // Match addresses: every /api/matches/:id route takes the UUID or the readable slug; the slug is swapped for the UUID here.
  app.addHook("preValidation", async (req, reply) => {
    const params = req.params as { id?: string } | undefined;
    if (!params?.id || !req.url.startsWith("/api/matches/")) return;
    const id = await resolveMatchRef(db, params.id);
    if (id === "bad") return reply.code(400).send({ error: "bad match id" });
    if (!id) return reply.code(404).send({ error: "match not found" });
    params.id = id;
  });
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: "cross-site request refused" });
  });
  // Game commands: a per-minute cap no hand reaches (a loop does), and a log of every one for the fair-play scan.
  app.addHook("preHandler", async (req, reply) => {
    if (!isCommand(req.method, req.url) || !req.user) return;
    const minute = Math.floor(Date.now() / 60_000);
    const key = `lt-cmd:${req.user.id}:${minute}`;
    const n = await redis.incr(key).catch(() => 0);
    if (n === 1) await redis.expire(key, 90).catch(() => {});
    if (n > balance.fairplay.commandsPerMinute) return reply.code(429).send({ error: `slow down: more than ${balance.fairplay.commandsPerMinute} commands a minute is not play` });
  });
  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode >= 300 || !req.user || !isCommand(req.method, req.url)) return;
    const matchId = (req.params as { id?: string } | undefined)?.id;
    if (!matchId) return;
    const kind = req.url.split("?")[0]!.replace(/^\/api\/matches\/[^/]+\//, "").replace(/[0-9a-f-]{36}/g, ":id").slice(0, 60);
    await db.insert(playerActions).values({ matchId, userId: req.user.id, kind }).catch(() => {});
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

  await app.register(clientErrorRoutes);
  await app.register(authRoutes, { db, redis, publisher });
  await app.register(matchRoutes, { db, publisher });
  await app.register(jobRoutes, { db, publisher });
  await app.register(armyRoutes, { db, publisher });
  await app.register(messageRoutes, { db });
  await app.register(allianceRoutes, { db, publisher });
  await app.register(chatRoutes, { db, publisher, redis });
  await app.register(marketRoutes, { db, publisher });
  await app.register(leaderboardRoutes, { db });
  await app.register(adminRoutes, { db, publisher, redis });
  await app.register(registrationRoutes, { db, redis });
  await app.register(publicRoutes, { db });
  await app.register(matchPageRoutes, { db });
  await app.register(tradeRouteRoutes, { db, publisher });
  await app.register(feedRoutes, { db });
  await app.register(eventRoutes, { db, publisher });
  await app.register(advisorRoutes, { db, publisher });
  await app.register(battleRoutes, { db });
  await app.register(diplomacyRoutes, { db, publisher });
  if (deps.realtime !== false) await app.register(registerWebsocket, { db });

  app.addHook("onClose", async () => {
    await redis.quit().catch(() => {});
    if (!deps.db) await db.close();
  });

  return app;
}
