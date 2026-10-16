/**
 * Send the "match has started" mail to every human in a match that already runs.
 *   node dist/scripts/notifyStarted.js 2026-10-silent-vanguard
 */
import { createDb } from "../db/client.js";
import { mailMatchStarted } from "../matches/start.js";
import { resolveMatchRef } from "../matches/slug.js";

const arg = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (arg.endsWith("/notifyStarted.js") || arg.endsWith("/notifyStarted.ts")) {
  const ref = process.argv[2];
  if (!ref) {
    console.error("usage: notifyStarted <match slug or id>");
    process.exit(2);
  }
  const db = createDb();
  const id = await resolveMatchRef(db, ref);
  if (!id || id === "bad") {
    console.error("no such match");
    await db.close();
    process.exit(2);
  }
  const n = await mailMatchStarted(db, id);
  // Give the fire-and-forget mails a moment to leave before the process ends.
  await new Promise((r) => setTimeout(r, 4000));
  console.log(JSON.stringify({ match: ref, mailed: n }));
  await db.close();
}
