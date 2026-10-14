/**
 * The match clock: server time plus the match's dev-only clock offset.
 * Every piece of simulation code asks this helper for "now" instead of
 * reading Date.now() directly, so time-skips affect everything consistently.
 */
export interface HasClockOffset {
  clockOffsetSeconds: number;
}

export function matchNow(match: HasClockOffset, realNow: Date = new Date()): Date {
  return new Date(realNow.getTime() + match.clockOffsetSeconds * 1000);
}

/** Real seconds elapsed between two instants, never negative. */
/** Match day (0-based, fractional) at `now` on the match clock. */
export function matchDayAt(m: { startsAt: Date | null; speed: number }, now: Date): number {
  if (!m.startsAt) return 0;
  return Math.max(0, ((now.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed);
}

export function elapsedSeconds(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 1000);
}
