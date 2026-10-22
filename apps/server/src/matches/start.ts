import { eq, and, isNull, sql } from "drizzle-orm";
import { enterMap, mapOf } from "../map/scope.js";
import { allRegions, balance, distanceKm, seededRng } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { events, jobs, matchRegions, matches, players, tournamentRegistrations } from "../db/schema.js";
import { foundCapital, type Tx } from "../sim/regions.js";
import { matchDayAt, matchNow } from "../sim/clock.js";
import { isTournament } from "./registrations.js";
import { notify } from "../worker/jobs.js";
import type { Publisher } from "../realtime/publish.js";
import { startOptionsFor } from "./startOptions.js";
import { logger } from "../logger.js";
import { randomProfile } from "../sim/ai.js";
import { scheduleIce } from "../sim/ice.js";
import { sendMail, startedMail } from "../mail.js";
import { users } from "../db/schema.js";

/** Every human in the match hears that it has begun, with a link to the map. Returns how many mails went out. */
export async function mailMatchStarted(db: Db, matchId: string): Promise<number> {
  const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!m) return 0;
  const humans = await db
    .select({ email: users.email, name: users.displayName })
    .from(players)
    .innerJoin(users, eq(users.id, players.userId))
    .where(and(eq(players.matchId, matchId), eq(players.isAi, false)));
  const total = (await db.select({ id: players.id }).from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, false)))).length;
  for (const h of humans) {
    const mail = startedMail(h.name, m.name, m.slug ?? m.id, m.speed, total);
    void sendMail(h.email, mail.subject, mail.text, mail.html);
  }
  return humans.length;
}

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
    enterMap(mapOf(m));

    const now = matchNow(m);
    const endsAt = new Date(now.getTime() + matchLengthSeconds(m.speed) * 1000);
    const protectionUntil = new Date(now.getTime() + (balance.match.protectionDays * 86400 * 1000) / m.speed);
    const rng = seededRng(`${m.seed}:start`);
    const settings = (m.settings ?? {}) as { aiFillTo?: number; neutralTribes?: number; aiDifficulty?: string };

    // Registered players are in whether or not they came to the lobby: anyone registered who has not joined is enrolled
    // now, and takes a starting region at random below like anyone who joined without picking.
    const joined = await tx.select({ userId: players.userId }).from(players).where(eq(players.matchId, matchId));
    const joinedIds = new Set(joined.map((p) => p.userId).filter((x): x is string => !!x));
    const registered = await tx
      .select({ userId: users.id, name: users.displayName })
      .from(tournamentRegistrations)
      .innerJoin(users, eq(users.id, tournamentRegistrations.userId))
      .where(and(eq(tournamentRegistrations.matchId, matchId), isNull(users.suspendedAt)));
    let humanCount = joined.filter((p) => p.userId).length;
    for (const r of registered) {
      if (joinedIds.has(r.userId) || humanCount >= balance.match.maxHumanPlayers) continue;
      await tx.insert(players).values({ matchId, userId: r.userId, name: r.name });
      humanCount += 1;
    }

    // Fill empty slots with AI tribes.
    const humans = await tx.select().from(players).where(eq(players.matchId, matchId));
    const fillTo = Math.min(balance.match.maxHumanPlayers, settings.aiFillTo ?? balance.ai.fillTo);
    const names = [...balance.ai.names].sort(() => rng() - 0.5);
    for (let i = humans.length; i < fillTo; i++) {
      const base = names[i % names.length]!;
      const name = i < names.length ? base : `${base} ${Math.floor(i / names.length) + 1}`;
      await tx.insert(players).values({ matchId, isAi: true, aiProfile: randomProfile(rng, settings.aiDifficulty), name });
    }

    // The hordes belong to a hidden player with no capital, no standings and no turn of its own.
    const [hordeRow] = await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, true))).limit(1);
    if (!hordeRow) await tx.insert(players).values({ matchId, isAi: true, hidden: true, aiProfile: "horde", name: balance.events.horde.name, protectionUntil: now, nextAiAt: null });

    const ps = (await tx.select().from(players).where(eq(players.matchId, matchId))).filter((p) => !p.hidden);
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

  if (started) {
    await publisher.toMatch(matchId, "match.started");
    await mailMatchStarted(db, matchId);
  }
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
    const ore = (["copper", "tin", "iron"] as const)[Math.floor(rng() * 3)]!;
    const oreAmount = ai.neutralOre.min + Math.floor(rng() * (ai.neutralOre.max - ai.neutralOre.min + 1));
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
        special: { [ore]: oreAmount },
        assignment: { food: 0.7, wood: 0.2, stone: 0.1 },
        settledAt: now,
      })
      .onConflictDoNothing();
  }
}

/**
 * A running tournament's registered players who are not in it yet (a start that ran before enrolment existed, or a
 * registration the start missed) come in during the first days: a player row, a free starting region, fresh
 * protection. Returns how many were enrolled; `onlyUserId` restricts it to one person (the join route).
 */
export async function enrolRegistered(db: Db, matchId: string, onlyUserId?: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [m] = await tx.select().from(matches).where(eq(matches.id, matchId)).for("update");
    if (!m || m.status !== "running" || !isTournament(m.settings)) return 0;
    const now = matchNow(m);
    if (matchDayAt(m, now) > balance.schedule.lateJoinDays) return 0;
    const joined = new Set((await tx.select({ userId: players.userId }).from(players).where(eq(players.matchId, matchId))).map((p) => p.userId).filter((x): x is string => !!x));
    const registered = await tx
      .select({ userId: users.id, name: users.displayName })
      .from(tournamentRegistrations)
      .innerJoin(users, eq(users.id, tournamentRegistrations.userId))
      .where(and(eq(tournamentRegistrations.matchId, matchId), isNull(users.suspendedAt), ...(onlyUserId ? [eq(users.id, onlyUserId)] : [])));
    const taken = (await tx.select({ capital: players.capitalRegionId }).from(players).where(eq(players.matchId, matchId))).map((p) => p.capital).filter((x): x is string => !!x);
    const protectionUntil = new Date(now.getTime() + (balance.match.protectionDays * 86400 * 1000) / m.speed);
    let n = 0;
    for (const r of registered) {
      if (joined.has(r.userId) || joined.size + n >= balance.match.maxHumanPlayers) continue;
      const [p] = await tx.insert(players).values({ matchId, userId: r.userId, name: r.name, protectionUntil }).returning();
      const capital = startOptionsFor(m.seed, p!.id, taken)[0];
      if (!capital) {
        logger.warn({ matchId, playerId: p!.id }, "no capital available for a late-enrolled player");
        continue;
      }
      taken.push(capital);
      await tx.update(players).set({ capitalRegionId: capital }).where(eq(players.id, p!.id));
      await foundCapital(tx, matchId, p!.id, capital, now);
      await notify(tx, matchId, p!.id, "system", `You are in "${m.name}". A starting region was chosen for you; your five settlers are at work there now, and nobody can attack you for the first ${balance.match.protectionDays} days.`, { regionId: capital });
      await tx.insert(events).values({ matchId, at: now, kind: "player.joined", payload: { playerId: p!.id, name: r.name, late: true } });
      n += 1;
    }
    void sql;
    return n;
  });
}
