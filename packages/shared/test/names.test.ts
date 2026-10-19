import { describe, expect, it } from "vitest";
import { nameProblem, normaliseName } from "../src/rules/names.js";

describe("chosen names", () => {
  it("lets ordinary names through, including ones that merely contain a rude string", () => {
    for (const n of ["Deez Frozen Nuts", "Cassandra", "Scunthorpe FC", "Cumberland", "Sheila", "Therapist", "Juniper", "Iron Wolves", "Max-77", "Ice Co", "Canad1an", "Analyst"]) {
      expect(nameProblem(n), n).toBeNull();
    }
  });

  it("refuses addresses and pitches, however they are spelled", () => {
    for (const n of ["lastthaw.com", "visit www.example.net", "best-casino-online", "fr33 cryp7o", "BTC giveaway", "promo code 2026", "DM me", "OnlyFans Ana", "Join my Telegram", "example dot com", "http://x", "cheap slots"]) {
      expect(nameProblem(n), n).not.toBeNull();
    }
  });

  it("refuses crude words and slurs, including look-alike spellings", () => {
    for (const n of ["F.U.C.K you", "Fuuuuck", "sh1t head", "N1gger", "faggot", "Hitler Fan", "a$$hole", "re7ard", "biTch", "c u n t"]) {
      expect(nameProblem(n), n).not.toBeNull();
    }
  });

  it("normalises look-alikes and repeats", () => {
    expect(normaliseName("Fr33 Cryp7o!!!")).toBe("free cryptoii");
    expect(normaliseName("Fuuuuck")).toBe("fuuck");
  });
});
