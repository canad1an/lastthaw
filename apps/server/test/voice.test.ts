import { describe, expect, it } from "vitest";
import { balance, seededRng } from "@lastthaw/shared";
import { composeBattleLine, composePost, postToDiscord, postingDays, type TribeFacts } from "../src/sim/tribeVoice.js";

process.env.DATABASE_URL ??= "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";

const facts = (over: Partial<TribeFacts> = {}): TribeFacts => ({
  tribe: "Pinecrest",
  match: "Frozen Vanguard",
  day: 12,
  age: 2,
  regions: 9,
  rank: 1,
  of: 20,
  capital: "Goias",
  daysToIce: 14,
  lastBattle: { won: true, attacker: true, other: "Ravensholt", region: "Kalahari" },
  leader: null,
  temperament: "raider",
  ...over,
});

/** The tribes' Discord voice: how often they speak, what they say, and that they stay silent without a webhook. */
describe("tribe voice", () => {
  it("speaks between one and ten times a match, on days fixed by the seed", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const days = postingDays("seed", `player-${i}`);
      expect(days.length).toBeGreaterThanOrEqual(balance.discord.postsPerTribe.min);
      expect(days.length).toBeLessThanOrEqual(balance.discord.postsPerTribe.max);
      expect(new Set(days).size).toBe(days.length);
      for (const d of days) {
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThan(balance.match.lengthDays);
      }
      seen.add(days.length);
    }
    expect(seen.size).toBeGreaterThan(5);
    expect(postingDays("seed", "p")).toEqual(postingDays("seed", "p"));
    expect(postingDays("seed", "p")).not.toEqual(postingDays("other", "p"));
  });

  it("writes a post from the facts, in the tribe's voice, the same for the same seed", () => {
    const a = composePost(facts(), seededRng("x"));
    expect(a).toBe(composePost(facts(), seededRng("x")));
    expect(a).toContain("Day 12");
    expect(a).toContain("9 regions");
    expect(a).toContain("Iron");
    expect(a).toMatch(/Ravensholt|Kalahari/);
    const defended = composePost(facts({ lastBattle: { won: false, attacker: false, other: "Dunmere", region: "Nubia" }, rank: 7, leader: "Kestrel", temperament: "peaceful" }), seededRng("y"));
    expect(defended).toContain("Dunmere");
    expect(defended).toContain("Kestrel");
    const freezing = composePost(facts({ daysToIce: 2, lastBattle: null }), seededRng("z"));
    expect(freezing).toMatch(/ice|frost|warmth/);
    expect(freezing).toContain("Goias");
    expect(composePost(facts({ regions: 1 }), seededRng("q"))).toMatch(/1 region[ .,]/);
    // A hundred seeds: never empty, never a mention, never over Discord's limit.
    for (let i = 0; i < 100; i++) {
      const p = composePost(facts({ day: i % 29 }), seededRng(`s${i}`));
      expect(p.length).toBeGreaterThan(20);
      expect(p.length).toBeLessThan(1900);
      expect(p).not.toContain("@");
    }
  });

  it("reacts to a battle from its own side of it", () => {
    const base = { other: "Ravensholt", region: "Kalahari", temperament: "balanced" as const };
    expect(composeBattleLine({ ...base, attacker: true, won: true, conquered: true }, seededRng("a"))).toMatch(/Kalahari/);
    expect(composeBattleLine({ ...base, attacker: false, won: false, conquered: true }, seededRng("b"))).toMatch(/Ravensholt/);
    const lines = new Set<string>();
    for (let i = 0; i < 40; i++) lines.add(composeBattleLine({ ...base, attacker: i % 2 === 0, won: i % 3 === 0, conquered: i % 5 === 0, temperament: (["peaceful", "balanced", "raider"] as const)[i % 3]! }, seededRng(`c${i}`)));
    expect(lines.size).toBeGreaterThan(10);
    for (const l of lines) expect(l).not.toContain("@");
    // In the match chat the posts do not name the match.
    const chat = composePost(facts({ match: "" }), seededRng("d"));
    expect(chat).not.toContain(" in .");
    expect(chat.length).toBeGreaterThan(20);
  });

  it("stays quiet without a webhook", async () => {
    delete process.env.DISCORD_WEBHOOK_URL;
    expect(await postToDiscord("Pinecrest", "hello")).toBe(false);
  });
});
