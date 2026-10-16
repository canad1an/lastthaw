import { and, eq, lte, sql } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { matches } from "../db/schema.js";
import { logger } from "../logger.js";
import { createRedis } from "../redis.js";
import { Publisher } from "../realtime/publish.js";
import { startMatch } from "../matches/start.js";
import { runDueJobs } from "./jobs.js";
import { runMatchTicks } from "../sim/tick.js";
import { ensureWeeklyMatch } from "./weekly.js";
import { sendTournamentReminders } from "../matches/registrations.js";
import { runTradeRoutes, runOverflow } from "../sim/trade.js";
import { detectAutomation, detectMultiAccounts, pruneActions } from "../fairplay/detect.js";
import { cleanupSessions } from "../auth/session.js";
import { balance } from "@lastthaw/shared";

/**
 * Simulation worker. One process serves every concurrent match.
 *  - scheduler (5s): starts lobby matches whose start time has passed
 *  - due-job loop (1s): completes timed actions in ends_at order
 *  - match tick (30s poll): loyalty, rebellions, scores, win check, AI
 */
const db = createDb();
const redis = createRedis();
const publisher = new Publisher(redis);
const log = logger.child({ proc: "worker" });
let stopping = false;

async function scheduler() {
  const due = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.status, "lobby"), lte(matches.startsAt, sql`now() + make_interval(secs => ${matches.clockOffsetSeconds})`)));
  for (const m of due) {
    try {
      if (await startMatch(db, publisher, m.id)) log.info({ matchId: m.id }, "match started");
    } catch (err) {
      log.error({ err, matchId: m.id }, "failed to start match");
    }
  }
}

async function every(ms: number, name: string, fn: () => Promise<void>) {
  while (!stopping) {
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      log.error({ err, loop: name }, "loop iteration failed");
    }
    await new Promise((r) => setTimeout(r, Math.max(0, ms - (Date.now() - started))));
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    void Promise.all([db.close(), redis.quit()]).then(() => process.exit(0));
  });
}

// Sanity: fail fast if the database is unreachable.
await db.execute(sql`select 1`);
log.info("worker started");
await Promise.all([
  every(5000, "scheduler", scheduler),
  every(1000, "jobs", async () => {
    await runDueJobs(db, publisher, log);
    // Heartbeat for the admin page: a missing or stale beat means the worker is down.
    await redis.set("lt-heartbeat:worker", new Date().toISOString(), "EX", 60).catch(() => {});
  }),
  every(Number(process.env.TICK_MS) || 30_000, "tick", () => runMatchTicks(db, publisher, log)),
  every(60_000, "weekly", () => ensureWeeklyMatch(db, log)),
  every(60_000, "reminders", async () => {
    await sendTournamentReminders(db, log);
  }),
  every(Number(process.env.TICK_MS) || 30_000, "trade", async () => {
    await runTradeRoutes(db, publisher, log);
    await runOverflow(db, publisher, log);
  }),
  every(6 * 3600_000, "sessions", async () => {
    const n = await cleanupSessions(db);
    if (n.sessions || n.tokens) log.info(n, "expired sessions and tokens removed");
  }),
  every(balance.fairplay.scanMinutes * 60_000, "fairplay", async () => {
    const n = (await detectMultiAccounts(db)) + (await detectAutomation(db));
    if (n) log.info({ flags: n }, "fairplay flags created");
    const pruned = await pruneActions(db);
    if (pruned) log.info({ pruned }, "old command rows removed");
  }),
]);
