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

// The first deploy of sendAdminReport (1e7034d) left it out of the esbuild entry points, so the api image had no
// dist/scripts/sendAdminReport.js and the nightly report could not be sent from the box.
describe("operations scripts in the api image", () => {
  it("esbuild builds sendAdminReport", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const cfg = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../esbuild.config.mjs"), "utf8");
    expect(cfg).toContain('"src/scripts/sendAdminReport.ts"');
  });
});
