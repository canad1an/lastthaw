import { describe, expect, it } from "vitest";
import { DISCORD_INVITE_URL } from "@lastthaw/shared";
import { welcomeMail } from "../src/mail.js";

describe("the welcome mail", () => {
  it("greets by name, points at the lobby and carries the Discord invite in the text, the HTML and the button", () => {
    const m = welcomeMail("Ann");
    expect(m.subject).toBe("Welcome to Last Thaw");
    expect(m.text).toContain("Welcome, Ann");
    expect(m.text).toContain(DISCORD_INVITE_URL);
    expect(m.html).toContain(DISCORD_INVITE_URL);
    expect(m.html).toContain("Join the Discord");
  });
});
