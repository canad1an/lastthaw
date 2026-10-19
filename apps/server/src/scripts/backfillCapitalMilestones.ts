/**
 * Award the capital milestone for capitals that fell before the rule existed: every player.eliminated event
 * with a conqueror in a running match earns the conqueror `capital_<loser>` (once; already-awarded ones are skipped),
 * and everyone in the match is told, as the live rule does. The conqueror also gets the realm message (the pop-up listing
 * every inherited region) when none was sent: the game keeps no ownership history, so the list is rebuilt from what the
 * conqueror holds today that is marked conquered and was never taken by a battle of theirs, the fallen capital first.
 *
 *   node dist/scripts/backfillCapitalMilestones.js [slug or id]     (production, inside the api image; all running matches when no slug is given)
 *   npx tsx src/scripts/backfillCapitalMilestones.ts [slug or id]   (local)
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { battles, events, matchRegions, matches, messages, players } from "../db/schema.js";
import { regionById } from "@lastthaw/shared";
import { resolveMatchRef } from "../matches/slug.js";
import { awardMilestone } from "../sim/endgame.js";
import { notify } from "../worker/jobs.js";

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
      // The realm message, if the fall predates it.
      const [told] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.matchId, id), eq(messages.playerId, by.id), sql`${messages.payload}->>'realmTaken' = 'true'`, sql`${messages.payload}->>'eliminated' = ${p.playerId}`))
        .limit(1);
      if (told) continue;
      const fights = await db
        .select({ regionId: battles.regionId, resolvedAt: battles.resolvedAt, report: battles.report })
        .from(battles)
        .where(and(eq(battles.matchId, id), eq(battles.attackerPlayerId, by.id)));
      const wonByBattle = new Set(fights.filter((x) => (x.report as { conquered?: boolean }).conquered).map((x) => x.regionId));
      // The capital: the conquest that resolved at the moment of the fall.
      const capital = fights.find((x) => (x.report as { conquered?: boolean }).conquered && Math.abs(x.resolvedAt.getTime() - f.at.getTime()) < 5_000)?.regionId ?? null;
      const held = await db
        .select({ regionId: matchRegions.regionId, popWorkers: matchRegions.popWorkers, popSoldiers: matchRegions.popSoldiers, popOccupiers: matchRegions.popOccupiers, buildings: matchRegions.buildings })
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, id), eq(matchRegions.ownerPlayerId, by.id), eq(matchRegions.conquered, true)));
      const regions = held
        .filter((r) => r.regionId === capital || !wonByBattle.has(r.regionId))
        .map((r) => ({ id: r.regionId, name: regionById(r.regionId)?.name ?? r.regionId, people: Math.round(r.popWorkers + r.popSoldiers + r.popOccupiers), buildings: Object.values(r.buildings).reduce((a, b) => a + b, 0), capital: r.regionId === capital }))
        .sort((a, b) => Number(b.capital) - Number(a.capital) || b.people - a.people);
      if (regions.length === 0) continue;
      await db.transaction((tx) =>
        notify(tx, id, by.id, "battle", `You took ${loser?.name ?? "a tribe"}'s capital: ${regions.length} region${regions.length === 1 ? "" : "s"} and everyone in them are yours now`, { realmTaken: true, eliminated: p.playerId, loserName: loser?.name ?? null, regionId: capital ?? regions[0]!.id, regions, reconstructed: true }),
      );
      console.log(`${m.name}: ${by.name} told of ${regions.length} regions inherited from ${loser?.name ?? p.playerId}`);
    }
  }
  console.log(`${awarded} milestone${awarded === 1 ? "" : "s"} awarded`);
  await db.close();
}
