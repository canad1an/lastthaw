/**
 * Time helpers shared by server and client.
 * All durations are in seconds of real time unless stated otherwise.
 */

/** Scale a base duration by the match speed multiplier. Never returns less than 1s. */
export function scaledDuration(baseSeconds: number, speed: number): number {
  if (speed <= 0) throw new Error("speed must be positive");
  return Math.max(1, Math.round(baseSeconds / speed));
}

/** Convert elapsed real seconds into elapsed game hours at the given speed. */
export function realSecondsToGameHours(realSeconds: number, speed: number): number {
  return (realSeconds * speed) / 3600;
}

/** Human-readable countdown such as "2h 14m" or "45s". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
