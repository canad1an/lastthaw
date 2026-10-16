import { sql } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { logger } from "../logger.js";
import { createRedis } from "../redis.js";
import { Publisher } from "../realtime/publish.js";
import { runAiDecisions } from "../sim/tick.js";

/**
 * AI process. Runs AI tribes' decisions on its own cadence so a slow or busy
 * AI pass can never delay job completion or the match tick in the worker.
 * Safe to run more than one: nextAiAt is advanced per decision, and each
 * command is its own short transaction.
 */
const db = createDb();
const redis = createRedis();
const publisher = new Publisher(redis);
const log = logger.child({ proc: "ai" });
let stopping = false;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    void Promise.all([db.close(), redis.quit()]).then(() => process.exit(0));
  });
}

await db.execute(sql`select 1`);
log.info("ai process started");
while (!stopping) {
  const started = Date.now();
  try {
    const n = await runAiDecisions(db, publisher, log);
    if (n) log.debug({ decisions: n, ms: Date.now() - started }, "ai pass");
    await redis.set("lt-heartbeat:ai", new Date().toISOString(), "EX", 120).catch(() => {});
  } catch (err) {
    log.error({ err }, "ai pass failed");
  }
  // AI_PASS_MS shortens the pass interval for high-speed test matches.
  await new Promise((r) => setTimeout(r, Math.max(250, (Number(process.env.AI_PASS_MS) || 15_000) - (Date.now() - started))));
}
