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

/** First match day on which the ice line reaches `absLat`, or null if it never does. */
export function freezeDayForLatitude(absLat: number): number | null {
  for (let day = 1; day <= balance.match.lengthDays; day++) {
    if (absLat >= iceLatitudeOnDay(day)) return day;
  }
  return null;
}

/** Latitudes that matter for the taper: the region's pole-facing tip and its centre, as absolute degrees. */
export interface IceShape {
  lat: number;
  latNorth?: number | undefined;
  latSouth?: number | undefined;
}

export function poleTipLatitude(r: IceShape): number {
  const north = r.latNorth ?? r.lat;
  const south = r.latSouth ?? r.lat;
  return r.lat >= 0 ? Math.abs(north) : Math.abs(south);
}

/**
 * How much of a region the ice has claimed on `day`.
 * factor 1 = untouched; between the tip and the centre production tapers to
 * `balance.ice.taperFloor`; past the centre the region is frozen (factor 0).
 */
export function iceExposure(r: IceShape, day: number): { frozen: boolean; factor: number; touched: boolean } {
  const line = iceLatitudeOnDay(day);
  const centre = Math.abs(r.lat);
  const tip = Math.max(centre, poleTipLatitude(r));
  if (centre >= line) return { frozen: true, factor: 0, touched: true };
  if (tip < line || tip <= centre) return { frozen: false, factor: 1, touched: false };
  const t = (tip - line) / (tip - centre); // 0 at the tip, 1 at the centre
  const factor = 1 - (1 - balance.ice.taperFloor) * Math.min(1, Math.max(0, t));
  return { frozen: false, factor, touched: true };
}

/** First day the ice touches the region's tip, and the day it freezes at the centre. */
export function iceDaysFor(r: IceShape): { touch: number | null; freeze: number | null } {
  return { touch: freezeDayForLatitude(poleTipLatitude(r)), freeze: freezeDayForLatitude(Math.abs(r.lat)) };
}
