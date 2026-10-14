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
