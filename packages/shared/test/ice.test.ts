import { describe, expect, it } from "vitest";
import { freezeDayForLatitude, iceLatitudeOnDay } from "../src/rules/ice.js";
import { allRegions } from "../src/map/index.js";

describe("ice schedule", () => {
  it("creeps toward the equator over the month", () => {
    expect(iceLatitudeOnDay(0)).toBeGreaterThan(iceLatitudeOnDay(15));
    expect(iceLatitudeOnDay(15)).toBeGreaterThan(iceLatitudeOnDay(30));
    expect(iceLatitudeOnDay(30)).toBeLessThan(35);
  });
  it("freezes most of the map by week four but not the tropics", () => {
    const regions = allRegions();
    const frozenDay28 = regions.filter((r) => Math.abs(r.lat) >= iceLatitudeOnDay(28)).length;
    expect(frozenDay28 / regions.length).toBeGreaterThan(0.35);
    expect(freezeDayForLatitude(5)).toBeNull();
    expect(freezeDayForLatitude(70)).toBeLessThanOrEqual(2);
  });
});

import { iceExposure, iceDaysFor } from "../src/rules/ice.js";

describe("ice taper", () => {
  const region = { lat: 55, latNorth: 60, latSouth: 49 };
  it("is untouched before the line reaches the tip, frozen past the centre, tapered between", () => {
    expect(iceExposure(region, 0)).toEqual({ frozen: false, factor: 1, touched: false });
    const day = iceDaysFor(region);
    expect(day.touch!).toBeLessThan(day.freeze!);
    const mid = iceExposure(region, (day.touch! + day.freeze!) / 2);
    expect(mid.touched).toBe(true);
    expect(mid.frozen).toBe(false);
    expect(mid.factor).toBeLessThan(1);
    expect(mid.factor).toBeGreaterThan(0.25);
    expect(iceExposure(region, day.freeze!).frozen).toBe(true);
  });
  it("mirrors for the southern hemisphere", () => {
    const south = { lat: -55, latNorth: -49, latSouth: -60 };
    expect(iceDaysFor(south)).toEqual(iceDaysFor(region));
  });
});
