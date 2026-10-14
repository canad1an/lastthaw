import { and, eq, gt, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type pino from "pino";
import { balance } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matches } from "../db/schema.js";
import { matchLengthSeconds } from "../matches/start.js";

/**
 * Weekly scheduler: keep one auto-created lobby open for the next weekly start
 * (Mondays 00:00 UTC by default). Matches last 30 days, so four or five run
 * at once. Hand-made dev matches are ignored by this check.
 */
export async function ensureWeeklyMatch(db: Db, log: pino.Logger): Promise<void> {
  const s = balance.schedule;
  if (!s.enabled) return;
  const [open] = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.status, "lobby"), sql`${matches.settings}->>'weekly' = 'true'`, gt(matches.startsAt, new Date())))
    .limit(1);
  if (open) return;

  const startsAt = nextWeeklyStart(new Date(), s.weekday, s.hourUtc);
  const endsAt = new Date(startsAt.getTime() + matchLengthSeconds(balance.match.defaultSpeed) * 1000);
  const name = `Thaw ${startsAt.toISOString().slice(0, 10)}`;
  await db.insert(matches).values({
    name,
    speed: balance.match.defaultSpeed,
    seed: randomBytes(8).toString("hex"),
    startsAt,
    endsAt,
    settings: { weekly: true },
  });
  log.info({ name, startsAt }, "weekly match created");
}

/** Next occurrence of weekday (0 = Sunday) at hourUtc, strictly in the future. */
export function nextWeeklyStart(from: Date, weekday: number, hourUtc: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hourUtc, 0, 0, 0));
  const delta = (weekday - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  if (d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}
