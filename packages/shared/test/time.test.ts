import { describe, expect, it } from "vitest";
import { formatCountdown, scaledDuration } from "../src/rules/time.js";

describe("scaledDuration", () => {
  it("divides by speed and rounds", () => {
    expect(scaledDuration(600, 10)).toBe(60);
    expect(scaledDuration(7, 2)).toBe(4);
  });
  it("never goes below one second", () => {
    expect(scaledDuration(3, 10)).toBe(1);
  });
  it("rejects non-positive speed", () => {
    expect(() => scaledDuration(10, 0)).toThrow();
  });
});

describe("formatCountdown", () => {
  it("formats hours and minutes", () => {
    expect(formatCountdown(2 * 3600 + 14 * 60 + 5)).toBe("2h 14m");
  });
  it("formats seconds only", () => {
    expect(formatCountdown(45)).toBe("45s");
  });
  it("clamps negatives to zero", () => {
    expect(formatCountdown(-5)).toBe("0s");
  });
});
