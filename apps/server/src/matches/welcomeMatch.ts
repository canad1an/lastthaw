import { randomBytes } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { matches, players, sessions, users } from "../db/schema.js";
import { config } from "../config.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { finishMatch } from "../sim/endgame.js";
import { matchLengthSeconds } from "./start.js";
import { uniqueSlug } from "./slug.js";
import { pickMatchName } from "../worker/weekly.js";

export interface WelcomeMatch {
  id: string;
  slug: string;
  name: string;
  startsAt: Date;
  speed: number;
}

/**
 * A game of their own for a new player, made the moment their email is confirmed: public, starting half an hour
 * later, with them as its creator (so they may start it early or cancel it) and already seated in it.
 *
 * Only the first N confirmations after this shipped get one (WELCOME_MATCHES, counted from the matches that carry the
 * welcome mark, so the cap holds across restarts); a player gets at most one, held by a unique index on the user id
 * in the match settings, so a repeated confirmation or a retried request can never make a second.
 */
export async function createWelcomeMatch(
  db: Db,
  user: { id: string; displayName: string },
  log?: { warn: (obj: unknown, msg: string) => void },
  opts: { cap?: number; minutes?: number; speed?: number } = {},
): Promise<WelcomeMatch | null> {
  const cap = opts.cap ?? config().WELCOME_MATCHES;
  const minutes = opts.minutes ?? config().WELCOME_MATCH_MINUTES;
  const speed = opts.speed ?? 1;
  const existing = await welcomeMatchOf(db, user.id);
  if (existing) return existing;
  const [made] = await db.select({ n: sql<number>`count(*)::int` }).from(matches).where(sql`${matches.settings}->>'welcome' = 'true'`);
  if ((made?.n ?? 0) >= cap) return null;
  const taken = new Set((await db.select({ name: matches.name }).from(matches)).map((r) => r.name.toLowerCase()));
  const name = pickMatchName(taken, user.id);
  const startsAt = new Date(Date.now() + minutes * 60_000);
  const endsAt = new Date(startsAt.getTime() + matchLengthSeconds(speed) * 1000);
  const slug = await uniqueSlug(db, name, startsAt);
  try {
    return await db.transaction(async (tx) => {
      const [m] = await tx
        .insert(matches)
        .values({
          name,
          slug,
          speed,
          seed: randomBytes(8).toString("hex"),
          startsAt,
          endsAt,
          settings: { createdBy: user.id, kind: "public", aiFillTo: 20, welcome: true, welcomeFor: user.id },
        })
        .returning({ id: matches.id, slug: matches.slug, name: matches.name, startsAt: matches.startsAt, speed: matches.speed });
      if (!m) throw new Error("welcome match insert returned nothing");
      await tx.insert(players).values({ matchId: m.id, userId: user.id, name: user.displayName });
      return { id: m.id, slug: m.slug ?? m.id, name: m.name, startsAt: m.startsAt, speed: m.speed };
    });
  } catch (err) {
    // Two confirmations racing: the unique index lets one through; the other finds it.
    const again = await welcomeMatchOf(db, user.id);
    if (again) return again;
    log?.warn({ err, userId: user.id }, "welcome match not created");
    return null;
  }
}

/**
 * A welcome game whose player has gone quiet is closed: once the game is older than the idle limit and the player has
 * not been seen (no request on any session, no login) for that long, a game still in the lobby is cancelled and a
 * running one is ended early, exactly as its creator could have done. Returns how many were closed.
 */
export async function closeIdleWelcomeMatches(db: Db, publisher: Publisher, log?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void }, opts: { idleHours?: number } = {}): Promise<number> {
  const idleHours = opts.idleHours ?? config().WELCOME_MATCH_IDLE_HOURS;
  const cutoff = new Date(Date.now() - idleHours * 3600_000);
  const open = await db
    .select()
    .from(matches)
    .where(and(inArray(matches.status, ["lobby", "running"]), sql`${matches.settings}->>'welcome' = 'true'`, lt(matches.createdAt, cutoff)));
  let closed = 0;
  for (const m of open) {
    const ownerId = (m.settings as { welcomeFor?: string }).welcomeFor;
    if (!ownerId) continue;
    const [seen] = await db
      .select({ last: sql<string | null>`greatest(max(${sessions.lastSeenAt}), max(${users.lastLoginAt}))` })
      .from(users)
      .leftJoin(sessions, eq(sessions.userId, users.id))
      .where(eq(users.id, ownerId));
    const last = seen?.last ? new Date(seen.last) : null;
    if (last && last > cutoff) continue;
    try {
      if (m.status === "lobby") {
        await db.delete(matches).where(eq(matches.id, m.id));
        await publisher.toMatch(m.id, "match.cancelled", { name: m.name });
      } else {
        const after: Array<() => Promise<void>> = [];
        await db.transaction((tx) => finishMatch(tx, m, matchNow(m), publisher, (fn) => void after.push(fn), null, "ended"));
        for (const fn of after) await fn().catch(() => {});
      }
      closed += 1;
      log?.info({ matchId: m.id, name: m.name, status: m.status, ownerId, lastSeen: last?.toISOString() ?? null }, "welcome game closed: player idle");
    } catch (err) {
      log?.warn({ err, matchId: m.id }, "welcome game could not be closed");
    }
  }
  return closed;
}

/** The welcome match already made for this player, if any. */
export async function welcomeMatchOf(db: Db, userId: string): Promise<WelcomeMatch | null> {
  const [m] = await db
    .select({ id: matches.id, slug: matches.slug, name: matches.name, startsAt: matches.startsAt, speed: matches.speed })
    .from(matches)
    .where(sql`${matches.settings}->>'welcomeFor' = ${userId}`)
    .limit(1);
  return m ? { id: m.id, slug: m.slug ?? m.id, name: m.name, startsAt: m.startsAt, speed: m.speed } : null;
}
