import { balance } from "../config/balance.js";

/**
 * Latitude (absolute degrees) beyond which the world is frozen on a given
 * match day. Linear interpolation over the schedule in balance.ice.
 */
export function iceLatitudeOnDay(day: number): number {
  const s = balance.ice.schedule;
  if (day <= s[0]!.day) return s[0]!.latitude;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    if (day <= b.day) {
      const t = (day - a.day) / (b.day - a.day);
      return a.latitude + (b.latitude - a.latitude) * t;
    }
  }
  return s[s.length - 1]!.latitude;
}

/** First match day on which a region at `absLat` freezes, or null if it never does. */
export function freezeDayForLatitude(absLat: number): number | null {
  for (let day = 1; day <= balance.match.lengthDays; day++) {
    if (absLat >= iceLatitudeOnDay(day)) return day;
  }
  return null;
}
