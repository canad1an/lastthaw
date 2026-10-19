/**
 * Active time, not open-tab time. The browser says "active" whenever the player touches the page
 * (at most once every half minute); the clock credits the time up to IDLE_MS after the last touch
 * and no further, so a tab left open overnight earns a few minutes, not the night.
 */
export const IDLE_MS = 5 * 60_000;

export interface ActiveClock {
  /** When the socket opened. */
  startedAt: number;
  /** The last moment the browser reported the player doing something. */
  lastActiveAt: number;
  /** Time up to this moment has been credited (to `pending` or already to the database). */
  creditedUntil: number;
  /** Credited seconds not yet written to the database. */
  pendingMs: number;
  /** Active time in this whole session, for the longest-session figure. */
  sessionMs: number;
}

export function openClock(now: number): ActiveClock {
  return { startedAt: now, lastActiveAt: now, creditedUntil: now, pendingMs: 0, sessionMs: 0 };
}

/** Credit the time since the last credit, but never past the idle limit after the last touch. */
export function settle(c: ActiveClock, now: number): void {
  const until = Math.min(now, c.lastActiveAt + IDLE_MS);
  if (until > c.creditedUntil) {
    c.pendingMs += until - c.creditedUntil;
    c.sessionMs += until - c.creditedUntil;
    c.creditedUntil = until;
  }
}

/** The player did something: settle what came before, then the window starts again from now. */
export function touch(c: ActiveClock, now: number): void {
  settle(c, now);
  c.lastActiveAt = now;
  // A long gap means the credited mark is behind the new touch: time in the gap is never credited.
  if (c.creditedUntil < now) c.creditedUntil = now;
}

/** Take the credited seconds for writing; returns 0 when there is nothing to write. */
export function drain(c: ActiveClock, now: number): { seconds: number; sessionSeconds: number } {
  settle(c, now);
  const seconds = c.pendingMs / 1000;
  c.pendingMs = 0;
  return { seconds, sessionSeconds: c.sessionMs / 1000 };
}
