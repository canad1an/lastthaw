/**
 * Bring a running tournament's registered players in, those who are not in it yet, during its first days.
 *
 *   node dist/scripts/enrolRegistered.js 2026-10-frozen-vanguard   (production, inside the api image)
 *   npx tsx src/scripts/enrolRegistered.ts <slug or id>             (local)
 */
import { createDb } from "../db/client.js";
import { enrolRegistered } from "../matches/start.js";
import { resolveMatchRef } from "../matches/slug.js";

const arg = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (arg.endsWith("/enrolRegistered.js") || arg.endsWith("/enrolRegistered.ts")) {
  const ref = process.argv[2];
  if (!ref) {
    console.error("usage: enrolRegistered <match slug or id>");
    process.exit(2);
  }
  const db = createDb();
  const id = await resolveMatchRef(db, ref);
  if (!id || id === "bad") {
    console.error("no such match");
    await db.close();
    process.exit(2);
  }
  const n = await enrolRegistered(db, id);
  console.log(JSON.stringify({ match: ref, enrolled: n }));
  await db.close();
}
