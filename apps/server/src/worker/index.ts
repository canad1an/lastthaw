import { sql } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { logger } from "../logger.js";

/**
 * Simulation worker. M0 only proves the loop and database connectivity;
 * M1 adds the due-job loop, match tick and scheduler.
 */
const db = createDb();
const log = logger.child({ proc: "worker" });
let stopping = false;

async function loop() {
  while (!stopping) {
    const started = Date.now();
    try {
      const rows = await db.execute<{ now: string }>(sql`select now()::text as now`);
      log.debug({ dbNow: rows[0]?.now }, "heartbeat");
    } catch (err) {
      log.error({ err }, "loop iteration failed");
    }
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - elapsed)));
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    void db.close().then(() => process.exit(0));
  });
}

log.info("worker started");
await loop();
