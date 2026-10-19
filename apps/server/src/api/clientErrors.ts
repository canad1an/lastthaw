import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";

/**
 * What the browser reports when something breaks on its side: an uncaught error, a promise nobody caught,
 * a screen that crashed while rendering, a request that came back 5xx or with a body the client could not read.
 * Each lands in the API log at error level, tagged clientError, so the nightly run picks it up with the server's own errors.
 */
const clientErrorBody = z.object({
  kind: z.enum(["error", "rejection", "render", "api", "schema"]),
  message: z.string().min(1).max(1000),
  stack: z.string().max(4000).optional(),
  url: z.string().max(500),
  /** For api/schema reports: the request that failed. */
  request: z.string().max(300).optional(),
  status: z.number().int().optional(),
  version: z.string().max(40).optional(),
  userAgent: z.string().max(300).optional(),
});

export type ClientErrorBody = z.infer<typeof clientErrorBody>;

export async function clientErrorRoutes(app: FastifyInstance) {
  // A broken page can loop; thirty reports a minute per address is plenty to see what went wrong.
  const tight = { config: { rateLimit: { max: config().LOAD_TEST ? 1_000_000 : 30, timeWindow: "1 minute" } } };
  app.post("/api/client-errors", tight, async (req, reply) => {
    const body = clientErrorBody.parse(req.body);
    app.log.error(
      {
        clientError: true,
        kind: body.kind,
        url: body.url,
        request: body.request,
        status: body.status,
        version: body.version,
        userAgent: body.userAgent ?? req.headers["user-agent"],
        userId: req.user?.id ?? null,
        stack: body.stack,
      },
      `client error: ${body.message}`,
    );
    return reply.code(204).send();
  });
}
