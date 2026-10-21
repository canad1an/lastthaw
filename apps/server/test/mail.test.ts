import { describe, expect, it } from "vitest";
import { ADMIN_ADDRESS, adminReportMessage } from "../src/mail.js";

// Matt (2026-10-21): every Last Thaw email comes from admin@lastthaw.com, even one it sends to itself.
// The nightly fixer had been mailing its report from a personal business mailbox.
describe("adminReportMessage", () => {
  it("is sent from admin@lastthaw.com to admin@lastthaw.com", () => {
    const m = adminReportMessage("[Last Thaw] nightly fixer 2026-10-21: nothing wrong", "all quiet");
    expect(ADMIN_ADDRESS).toBe("admin@lastthaw.com");
    expect(m.from).toBe("Last Thaw <admin@lastthaw.com>");
    expect(m.to).toBe("admin@lastthaw.com");
    expect(m.subject).toContain("nightly fixer");
    expect(m.text).toBe("all quiet");
  });
});
