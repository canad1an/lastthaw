import { eq } from "drizzle-orm";
import { allRegions, balance, distanceKm, seededRng } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { events, jobs, matchRegions, matches, players } from "../db/schema.js";
import { foundCapital, type Tx } from "../sim/regions.js";
import { matchNow } from "../sim/clock.js";
import type { Publisher } from "../realtime/publish.js";
import { startOptionsFor } from "./startOptions.js";
import { logger } from "../logger.js";
import { randomProfile } from "../sim/ai.js";
import { scheduleIce } from "../sim/ice.js";

/** Real-time length of a match in seconds at the given speed. */
export function matchLengthSeconds(speed: number): number {
  return (balance.match.lengthDays * 86400) / speed;
}

/**
 * Transition a lobby match to running: fill empty slots with AI tribes, found
 * every capital, scatter neutral tribes, start beginner protection, schedule
 * the ice and the match end. Idempotent.
 */
export async function startMatch(db: Db, publisher: Publisher, matchId: string): Promise<boolean> {
  const started = await db.transaction(async (tx) => {
    const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("update");
    if (!m || m.status !== "lobby") return false;

    const now = matchNow(m);
    const endsAt = new Date(now.getTime() + matchLengthSeconds(m.speed) * 1000);
    const protectionUntil = new Date(now.getTime() + (balance.match.protectionDays * 86400 * 1000) / m.speed);
    const rng = seededRng(`${m.seed}:start`);
    const settings = (m.settings ?? {}) as { aiFillTo?: number; neutralTribes?: number };

    // Fill empty slots with AI tribes.
    const humans = await tx.select().from(players).where(eq(players.matchId, matchId));
    const fillTo = Math.min(balance.match.maxHumanPlayers, settings.aiFillTo ?? balance.ai.fillTo);
    const names = [...balance.ai.names].sort(() => rng() - 0.5);
    for (let i = humans.length; i < fillTo; i++) {
      const base = names[i % names.length]!;
      const name = i < names.length ? base : `${base} ${Math.floor(i / names.length) + 1}`;
      await tx.insert(players).values({ matchId, isAi: true, aiProfile: randomProfile(rng), name });
    }

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
      await tx.update(players).set({ protectionUntil: p.isAi ? now : protectionUntil, nextAiAt: p.isAi ? now : null }).where(eq(players.id, p.id));
    }

    await placeNeutralTribes(tx, matchId, taken, settings.neutralTribes ?? balance.ai.neutralTribes, rng, now);

    await tx.update(matches).set({ status: "running", startsAt: now, endsAt, lastTickAt: now }).where(eq(matches.id, matchId));
    await tx.insert(jobs).values({ matchId, kind: "match_end", startsAt: now, endsAt });
    await scheduleIce(tx, matchId, now, m.speed);
    await tx.insert(events).values({ matchId, at: now, kind: "match.started", payload: { players: ps.length } });
    return true;
  });

  if (started) await publisher.toMatch(matchId, "match.started");
  return started;
}

/** Scatter neutral tribes away from every capital. */
async function placeNeutralTribes(tx: Tx, matchId: string, capitals: string[], count: number, rng: () => number, now: Date): Promise<void> {
  const ai = balance.ai;
  const pool = allRegions()
    .filter((r) => !capitals.includes(r.id) && r.terrain !== "tundra" && Math.abs(r.lat) < 62)
    .filter((r) => capitals.every((c) => distanceKm(r, c) >= ai.neutralMinDistanceKm))
    .map((r) => ({ r, k: rng() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, count)
    .map((x) => x.r);
  for (const r of pool) {
    const people = ai.neutralPeople.min + Math.floor(rng() * (ai.neutralPeople.max - ai.neutralPeople.min + 1));
    const warriors = ai.neutralWarriors.min + Math.floor(rng() * (ai.neutralWarriors.max - ai.neutralWarriors.min + 1));
    await tx
      .insert(matchRegions)
      .values({
        matchId,
        regionId: r.id,
        ownerPlayerId: null,
        popWorkers: people,
        popSoldiers: warriors,
        units: { warrior: warriors },
        food: 150,
        wood: 60,
        stone: 30,
        assignment: { food: 0.7, wood: 0.2, stone: 0.1 },
        settledAt: now,
      })
      .onConflictDoNothing();
  }
}
