/**
 * Award the capital milestone for capitals that fell before the rule existed: every player.eliminated event
 * with a conqueror in a running match earns the conqueror `capital_<loser>` (once; already-awarded ones are skipped),
 * and everyone in the match is told, as the live rule does.
 *
 *   node dist/scripts/backfillCapitalMilestones.js [slug or id]     (production, inside the api image; all running matches when no slug is given)
 *   npx tsx src/scripts/backfillCapitalMilestones.ts [slug or id]   (local)
 */
import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { events, matches, players } from "../db/schema.js";
import { resolveMatchRef } from "../matches/slug.js";
import { awardMilestone } from "../sim/endgame.js";

const arg = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (arg.endsWith("/backfillCapitalMilestones.js") || arg.endsWith("/backfillCapitalMilestones.ts")) {
  const db = createDb();
  const ref = process.argv[2];
  let ids: string[];
  if (ref) {
    const id = await resolveMatchRef(db, ref);
    if (!id || id === "bad") {
      console.error("no such match");
      await db.close();
      process.exit(2);
    }
    ids = [id];
  } else {
    ids = (await db.select({ id: matches.id }).from(matches).where(eq(matches.status, "running"))).map((m) => m.id);
  }
  let awarded = 0;
  for (const id of ids) {
    const [m] = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
    if (!m) continue;
    const falls = await db.select().from(events).where(and(eq(events.matchId, id), eq(events.kind, "player.eliminated")));
    for (const f of falls) {
      const p = f.payload as { playerId?: string; by?: string | null };
      if (!p.playerId || !p.by) continue;
      const [by] = await db.select({ id: players.id, name: players.name, hidden: players.hidden }).from(players).where(inArray(players.id, [p.by])).limit(1);
      const [loser] = await db.select({ name: players.name }).from(players).where(eq(players.id, p.playerId)).limit(1);
      if (!by || by.hidden) continue;
      const done = await db.transaction((tx) => awardMilestone(tx, m, `capital_${p.playerId}`, by.id, f.at, `Took ${loser?.name ?? "a tribe"}'s capital`));
      if (done) {
        awarded += 1;
        console.log(`${m.name}: ${by.name} awarded the capital of ${loser?.name ?? p.playerId}`);
      }
    }
  }
  console.log(`${awarded} milestone${awarded === 1 ? "" : "s"} awarded`);
  await db.close();
}
