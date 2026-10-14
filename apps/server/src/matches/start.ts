import { eq } from "drizzle-orm";
import { balance } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { events, jobs, matches, players } from "../db/schema.js";
import { foundCapital } from "../sim/regions.js";
import { matchNow } from "../sim/clock.js";
import type { Publisher } from "../realtime/publish.js";
import { startOptionsFor } from "./startOptions.js";
import { logger } from "../logger.js";

/** Real-time length of a match in seconds at the given speed. */
export function matchLengthSeconds(speed: number): number {
  return (balance.match.lengthDays * 86400) / speed;
}

/**
 * Transition a lobby match to running: found every player's capital, start
 * beginner protection, and schedule the match end. Idempotent.
 */
export async function startMatch(db: Db, publisher: Publisher, matchId: string): Promise<boolean> {
  const started = await db.transaction(async (tx) => {
    const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("update");
    if (!m || m.status !== "lobby") return false;

    const now = matchNow(m);
    const endsAt = new Date(now.getTime() + matchLengthSeconds(m.speed) * 1000);
    const protectionUntil = new Date(now.getTime() + (balance.match.protectionDays * 86400 * 1000) / m.speed);

    const ps = await tx.select().from(players).where(eq(players.matchId, matchId));
    const taken = ps.map((p) => p.capitalRegionId).filter((x): x is string => !!x);

    for (const p of ps) {
      let capital = p.capitalRegionId;
      if (!capital) {
        capital = startOptionsFor(m.seed, p.id, taken)[0] ?? null;
        if (!capital) {
          logger.warn({ matchId, playerId: p.id }, "no capital available for player");
          continue;
        }
        taken.push(capital);
        await tx.update(players).set({ capitalRegionId: capital }).where(eq(players.id, p.id));
      }
      await foundCapital(tx, matchId, p.id, capital, now);
      await tx.update(players).set({ protectionUntil }).where(eq(players.id, p.id));
    }

    await tx.update(matches).set({ status: "running", startsAt: now, endsAt }).where(eq(matches.id, matchId));
    await tx.insert(jobs).values({ matchId, kind: "match_end", startsAt: now, endsAt });
    await tx.insert(events).values({ matchId, at: now, kind: "match.started", payload: { players: ps.length } });
    return true;
  });

  if (started) await publisher.toMatch(matchId, "match.started");
  return started;
}
