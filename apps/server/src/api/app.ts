import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import type { HealthResponse } from "@lastthaw/shared";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { createDb, type Db } from "../db/client.js";
import { createRedis } from "../redis.js";
import { Publisher } from "../realtime/publish.js";
import { sessionPlugin } from "../auth/session.js";
import { authRoutes } from "../auth/routes.js";
import { matchRoutes } from "../matches/routes.js";
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
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  await app.register(websocket);
  await app.register(sessionPlugin, { db });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    ok: true,
    serverTime: new Date().toISOString(),
    version: VERSION,
  }));

  await app.register(authRoutes, { db });
  await app.register(matchRoutes, { db, publisher });
  if (deps.realtime !== false) await app.register(registerWebsocket, { db });

  app.addHook("onClose", async () => {
    await redis.quit().catch(() => {});
    if (!deps.db) await db.close();
  });

  return app;
}
