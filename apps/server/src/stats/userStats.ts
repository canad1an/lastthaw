import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { userStats } from "../db/schema.js";
import { deviceKey } from "./device.js";

/**
 * Per-account play statistics, kept for the admin page and never shown to other players: time online,
 * sessions, logins, the devices and browsers used, the hours of the day someone plays.
 * Every write is an upsert, so the first event for an account creates its row.
 */

async function ensure(db: Db, userId: string): Promise<void> {
  await db.insert(userStats).values({ userId }).onConflictDoNothing();
}

/** A login: one more, on this device, now. */
export async function recordLogin(db: Db, userId: string, userAgent: string | undefined): Promise<void> {
  await ensure(db, userId);
  const key = deviceKey(userAgent);
  await db
    .update(userStats)
    .set({
      logins: sql`${userStats.logins} + 1`,
      lastSeenAt: new Date(),
      devices: sql`jsonb_set(${userStats.devices}, array[${key}], to_jsonb(coalesce((${userStats.devices}->>${key})::int, 0) + 1), true)`,
    })
    .where(eq(userStats.userId, userId));
}

/** A live connection opened: a session on this device at this hour of the day (UTC). */
export async function recordSessionStart(db: Db, userId: string, userAgent: string | undefined, at = new Date()): Promise<void> {
  await ensure(db, userId);
  const key = deviceKey(userAgent);
  const hour = String(at.getUTCHours());
  await db
    .update(userStats)
    .set({
      sessions: sql`${userStats.sessions} + 1`,
      lastSeenAt: at,
      devices: sql`jsonb_set(${userStats.devices}, array[${key}], to_jsonb(coalesce((${userStats.devices}->>${key})::int, 0) + 1), true)`,
      hours: sql`jsonb_set(${userStats.hours}, array[${hour}], to_jsonb(coalesce((${userStats.hours}->>${hour})::int, 0) + 1), true)`,
    })
    .where(eq(userStats.userId, userId));
}

/** Time spent connected: added to the total, and to the longest session if this one beat it. */
export async function recordOnline(db: Db, userId: string, seconds: number, wholeSessionSeconds: number): Promise<void> {
  if (seconds <= 0) return;
  await ensure(db, userId);
  const add = Math.round(seconds);
  const whole = Math.round(wholeSessionSeconds);
  await db
    .update(userStats)
    .set({
      secondsOnline: sql`${userStats.secondsOnline} + ${add}`,
      longestSessionSeconds: sql`greatest(${userStats.longestSessionSeconds}, ${whole})`,
      lastSeenAt: new Date(),
    })
    .where(eq(userStats.userId, userId));
}
