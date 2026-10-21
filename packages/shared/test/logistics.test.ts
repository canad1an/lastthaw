import { describe, expect, it } from "vitest";
import { supplyConvoyCap } from "../src/rules/combat.js";
import { balance } from "../src/config/balance.js";

describe("materials convoy cap", () => {
  it("is the base cap for a small fleet and grows one per ten haulers beyond it", () => {
    const base = balance.trade.maxSupplyConvoys;
    const per = balance.trade.supplyConvoysPerHaulers;
    expect(supplyConvoyCap(0)).toBe(base);
    expect(supplyConvoyCap(base * per - 1)).toBe(base);
    expect(supplyConvoyCap(base * per)).toBe(base);
    expect(supplyConvoyCap(190)).toBe(Math.max(base, Math.floor(190 / per)));
    expect(supplyConvoyCap(190)).toBeGreaterThan(base);
  });
});
