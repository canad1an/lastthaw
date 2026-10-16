import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import type pino from "pino";
import { balance } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matches } from "../db/schema.js";
import { matchLengthSeconds } from "../matches/start.js";

const FIRST = ["Frozen", "Bitter", "Howling", "Iron", "Grey", "Silent", "Black", "Pale", "Long", "Broken", "Burning", "Crimson", "Northern", "Hollow", "Glacial", "Ashen", "Shattered", "Sleeping", "Starving", "Last", "White", "Cold", "Wild", "Endless", "Scarred", "Dying", "Bleak", "Savage", "Hungry", "Brittle"];
const SECOND = ["Winter", "Siege", "Frost", "Blizzard", "March", "Vanguard", "Thaw", "Tundra", "Glacier", "Campaign", "Redoubt", "Retreat", "Front", "Snowfall", "Hearth", "Ember", "Avalanche", "Garrison", "Rampart", "Ice", "Reckoning", "Crusade", "Dawn", "Watch", "Harvest", "Crossing", "Standoff", "Muster", "Advance", "Stand"];

/** A war-or-winter name no other match has: "Howling Siege", "Iron Thaw", and so on. */
export function pickMatchName(taken: ReadonlySet<string>, seed: string): string {
  for (let i = 0; i < 400; i++) {
    const h = createHash("sha256").update(`${seed}:${i}`).digest();
    const name = `${FIRST[h[0]! % FIRST.length]} ${SECOND[h[1]! % SECOND.length]}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
  return `Thaw ${seed.slice(0, 6)}`;
}

/**
 * Scheduler: keep `balance.schedule.upcoming` weekly lobbies open, one per week
 * (Mondays 00:00 UTC by default), each with a name of its own. Matches last 30
 * days, so four or five run at once. Hand-made matches are ignored by this check.
 */
export async function ensureWeeklyMatch(db: Db, log: pino.Logger): Promise<void> {
  const s = balance.schedule;
  if (!s.enabled) return;
  const now = new Date();
  const open = await db
    .select({ id: matches.id, startsAt: matches.startsAt })
    .from(matches)
    .where(and(eq(matches.status, "lobby"), sql`${matches.settings}->>'weekly' = 'true'`, gt(matches.startsAt, now)))
    .orderBy(matches.startsAt);
  if (open.length >= s.upcoming) return;

  const taken = new Set((await db.select({ name: matches.name }).from(matches)).map((r) => r.name.toLowerCase()));
  let startsAt = open.length ? nextWeeklyStart(open[open.length - 1]!.startsAt, s.weekday, s.hourUtc) : nextWeeklyStart(now, s.weekday, s.hourUtc);
  for (let i = open.length; i < s.upcoming; i++) {
    const endsAt = new Date(startsAt.getTime() + matchLengthSeconds(balance.match.defaultSpeed) * 1000);
    const seed = randomBytes(8).toString("hex");
    const name = pickMatchName(taken, seed);
    taken.add(name.toLowerCase());
    await db.insert(matches).values({ name, speed: balance.match.defaultSpeed, seed, startsAt, endsAt, settings: { weekly: true, kind: "tournament" } });
    log.info({ name, startsAt }, "tournament scheduled");
    startsAt = nextWeeklyStart(startsAt, s.weekday, s.hourUtc);
  }
  void inArray;
}

/** Next occurrence of weekday (0 = Sunday) at hourUtc, strictly in the future. */
export function nextWeeklyStart(from: Date, weekday: number, hourUtc: number): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hourUtc, 0, 0, 0));
  const delta = (weekday - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  if (d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}
