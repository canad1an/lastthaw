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
export function elapsedSeconds(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 1000);
}
