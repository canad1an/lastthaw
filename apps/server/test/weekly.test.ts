import { describe, expect, it } from "vitest";
import { nextWeeklyStart } from "../src/worker/weekly.js";

describe("nextWeeklyStart", () => {
  it("picks the coming Monday 00:00 UTC", () => {
    const wed = new Date("2026-10-14T15:00:00Z"); // Wednesday
    const next = nextWeeklyStart(wed, 1, 0);
    expect(next.toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });
  it("skips to the following week when the slot has just passed", () => {
    const mon = new Date("2026-10-19T00:00:01Z");
    expect(nextWeeklyStart(mon, 1, 0).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
  it("respects the hour", () => {
    const sun = new Date("2026-10-18T10:00:00Z");
    expect(nextWeeklyStart(sun, 1, 6).toISOString()).toBe("2026-10-19T06:00:00.000Z");
  });
});
