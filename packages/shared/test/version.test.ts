import { describe, expect, it } from "vitest";
import { isBrowserExtensionNoise, shouldReloadForNewVersion } from "../src/types/version.js";

// 2026-10-20: a phone left on Silent Vanguard on build 1.33 polled a 1.4x server whose armies could be
// "fighting"; every state poll failed to parse until the player reloaded by hand.
describe("shouldReloadForNewVersion", () => {
  it("reloads a stale page once when the server runs a newer build", () => {
    expect(shouldReloadForNewVersion("1.33", "1.41", null)).toBe(true);
  });

  it("does not reload again for the same server version (no loop on a real schema bug)", () => {
    expect(shouldReloadForNewVersion("1.33", "1.41", "1.41")).toBe(false);
  });

  it("reloads again when yet another build has gone out since", () => {
    expect(shouldReloadForNewVersion("1.41", "1.42", "1.41")).toBe(true);
  });

  it("never reloads when the versions match or the server's is unknown", () => {
    expect(shouldReloadForNewVersion("1.52", "1.52", null)).toBe(false);
    expect(shouldReloadForNewVersion("1.52", null, null)).toBe(false);
    expect(shouldReloadForNewVersion("1.52", "", null)).toBe(false);
  });
});

describe("isBrowserExtensionNoise", () => {
  it("drops an extension's own messaging failure (iPhone Safari, 2026-10-21)", () => {
    expect(isBrowserExtensionNoise("Invalid call to runtime.sendMessage(). Tab not found.")).toBe(true);
    expect(isBrowserExtensionNoise("boom", "Error: boom\n    at x (safari-web-extension://ABC/content.js:1:2)")).toBe(true);
    expect(isBrowserExtensionNoise("boom", "Error: boom\n    at x (chrome-extension://abc/inject.js:1:2)")).toBe(true);
  });

  it("keeps the game's own errors", () => {
    expect(isBrowserExtensionNoise("armies.24.status: Invalid option", "Error\n    at K (https://lastthaw.com/assets/index.js:64:41966)")).toBe(false);
    expect(isBrowserExtensionNoise("Cannot read properties of undefined (reading 'units')")).toBe(false);
  });
});
