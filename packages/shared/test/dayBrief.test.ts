import { describe, expect, it } from "vitest";
import { balance } from "../src/config/balance.js";
import { newOnDay } from "../src/rules/dayBrief.js";
import { techById } from "../src/config/ages.js";

describe("the morning brief's news", () => {
  it("opens the Iron Age on the morning Iron working may first be started, and not the day before", () => {
    const day = techById.get("iron_working")!.earliestDay! + 1;
    expect(newOnDay(day).some((s) => s.startsWith("The Iron Age opens: Iron working"))).toBe(true);
    expect(newOnDay(day - 1).some((s) => s.includes("Iron Age"))).toBe(false);
  });

  it("names the end of protection, the first blizzards, the Horde and the last day on their days", () => {
    expect(newOnDay(balance.match.protectionDays + 1).some((s) => s.startsWith("Beginner protection is over"))).toBe(true);
    expect(newOnDay(balance.events.storm.fromDay + 1).some((s) => s.startsWith("Blizzards"))).toBe(true);
    expect(newOnDay(balance.events.horde.fromDay + 1).some((s) => s.includes("can ride out"))).toBe(true);
    expect(newOnDay(balance.match.lengthDays).some((s) => s.startsWith("The last day"))).toBe(true);
    expect(newOnDay(balance.match.alliancesEndDay).some((s) => s.startsWith("Last day of alliances"))).toBe(true);
    expect(newOnDay(balance.match.alliancesEndDay + 1).some((s) => s.startsWith("Every alliance has dissolved"))).toBe(true);
  });

  it("every age after the Bronze Age opens on exactly one day", () => {
    const all = Array.from({ length: balance.match.lengthDays }, (_, i) => newOnDay(i + 1)).flat();
    for (const age of ["Iron", "Classical", "Medieval", "Industrial", "Modern"]) expect(all.filter((s) => s.startsWith(`The ${age} Age opens`))).toHaveLength(1);
  });
});
