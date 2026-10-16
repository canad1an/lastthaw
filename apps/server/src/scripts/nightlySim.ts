/**
 * Start the nightly simulation as a real game: a public 720x match with a
 * war-or-winter name, twenty AI tribes and no invite code, starting now. The
 * running worker and AI play it out in about an hour and it stays on the site
 * like any other finished game, with its report and replay.
 *
 *   node dist/scripts/nightlySim.js            (production, inside the api image)
 *   npx tsx src/scripts/nightlySim.ts          (local)
 */
import { randomBytes } from "node:crypto";
import { balance } from "@lastthaw/shared";
import { createDb, type Db } from "../db/client.js";
import { matches } from "../db/schema.js";
import { matchLengthSeconds } from "../matches/start.js";
import { pickMatchName } from "../worker/weekly.js";
import { uniqueSlug } from "../matches/slug.js";

export const SIM_SPEED = 720;

/** Insert the simulation match; the worker's scheduler starts it within seconds. */
export async function createSimMatch(db: Db, now = new Date()): Promise<{ id: string; name: string }> {
  const taken = new Set((await db.select({ name: matches.name }).from(matches)).map((r) => r.name.toLowerCase()));
  const name = pickMatchName(taken, randomBytes(8).toString("hex"));
  const endsAt = new Date(now.getTime() + matchLengthSeconds(SIM_SPEED) * 1000);
  const [m] = await db
    .insert(matches)
    .values({
      name,
      slug: await uniqueSlug(db, name, now),
      speed: SIM_SPEED,
      seed: randomBytes(8).toString("hex"),
      startsAt: now,
      endsAt,
      settings: { kind: "public", aiFillTo: balance.match.maxAiTribes, aiDifficulty: "mixed", simulation: true },
    })
    .returning({ id: matches.id, name: matches.name });
  return m!;
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/nightlySim.js") || process.argv[1]?.replace(/\\/g, "/").endsWith("/nightlySim.ts");
if (isMain) {
  const db = createDb();
  const m = await createSimMatch(db);
  console.log(JSON.stringify(m));
  await db.close();
}
