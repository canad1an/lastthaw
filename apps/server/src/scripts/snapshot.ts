/**
 * Pace recorder for high-speed test matches. Polls a running match and
 * appends one snapshot per interval (per-player score, age, regions,
 * population, stock, queues) to a JSON-lines file, then dumps the event log
 * when the match finishes.
 *
 *   npx tsx --env-file-if-exists=../../.env src/scripts/snapshot.ts <matchId> <out.jsonl> [intervalSeconds]
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { appendFileSync, writeFileSync } from "node:fs";
import { createDb } from "../db/client.js";
import { battles, events, jobs, matchRegions, matches, players } from "../db/schema.js";
import { matchNow } from "../sim/clock.js";

const [matchId, out, every] = process.argv.slice(2);
if (!matchId || !out) throw new Error("usage: snapshot.ts <matchId> <out.jsonl> [intervalSeconds]");
const intervalMs = (Number(every) || 30) * 1000;
const db = createDb();
writeFileSync(out, "");

for (;;) {
  const [m] = await db.select().from(matches).where(eq(matches.id, matchId));
  if (!m) throw new Error("match not found");
  if (m.status === "lobby") {
    await new Promise((r) => setTimeout(r, 2000));
    continue;
  }
  const now = matchNow(m);
  const day = ((now.getTime() - m.startsAt!.getTime()) / 86400_000) * m.speed;
  const ps = await db.select().from(players).where(eq(players.matchId, matchId)).orderBy(asc(players.createdAt));
  const regions = await db.select().from(matchRegions).where(eq(matchRegions.matchId, matchId));
  const pending = await db
    .select({ playerId: jobs.playerId, kind: jobs.kind, n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.matchId, matchId), isNull(jobs.completedAt), isNull(jobs.cancelledAt), inArray(jobs.kind, ["build", "research", "train", "mission"])))
    .groupBy(jobs.playerId, jobs.kind);
  const snap = {
    t: new Date().toISOString(),
    day: Math.round(day * 100) / 100,
    status: m.status,
    players: ps.map((p) => {
      const mine = regions.filter((r) => r.ownerPlayerId === p.id);
      const sum = (f: (r: (typeof regions)[number]) => number) => Math.round(mine.reduce((a, r) => a + f(r), 0));
      const q: Record<string, number> = {};
      for (const row of pending) if (row.playerId === p.id) q[row.kind] = row.n;
      const buildings = mine.reduce((a, r) => a + Object.values(r.buildings as Record<string, number>).reduce((x, y) => x + y, 0), 0);
      return {
        name: p.name,
        ai: p.aiProfile,
        age: p.age,
        score: p.score,
        regions: mine.length,
        frozen: mine.filter((r) => r.frozenAt).length,
        pop: sum((r) => r.popWorkers + r.popSoldiers + r.popOccupiers),
        food: sum((r) => r.food),
        wood: sum((r) => r.wood),
        stone: sum((r) => r.stone),
        buildingLevels: buildings,
        queues: q,
        eliminated: !!p.eliminatedAt,
      };
    }),
  };
  appendFileSync(out, JSON.stringify(snap) + "\n");
  console.log(`day ${snap.day.toFixed(1)} status ${m.status} leaders ${[...snap.players].sort((a, b) => b.score - a.score).slice(0, 3).map((p) => `${p.name}(${p.ai ?? "human"}) ${p.score} age${p.age}`).join(" | ")}`);
  if (m.status === "finished") {
    const log = await db.select().from(events).where(eq(events.matchId, matchId)).orderBy(asc(events.at));
    const fights = await db.select().from(battles).where(eq(battles.matchId, matchId));
    const done = await db
      .select({ kind: jobs.kind, refId: jobs.refId, level: jobs.level, qty: jobs.qty, playerId: jobs.playerId, startsAt: jobs.startsAt, endsAt: jobs.endsAt, completedAt: jobs.completedAt })
      .from(jobs)
      .where(and(eq(jobs.matchId, matchId), inArray(jobs.kind, ["build", "research", "train"])))
      .orderBy(asc(jobs.endsAt));
    writeFileSync(out.replace(/\.jsonl$/, "") + ".final.json", JSON.stringify({ match: m, players: ps, events: log, battles: fights.length, jobs: done, startsAt: m.startsAt }, null, 1));
    console.log(`finished: ${log.length} events, ${fights.length} battles, ${done.length} jobs written`);
    break;
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
await db.close();
