import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";

const { attemptCommand } = await import("../src/sim/ai.js");
const { httpError } = await import("../src/sim/commands.js");

const who = { matchId: "m1", playerId: "p1" };

/** An AI command that fails: the rules refusing it is quiet, the server failing it is logged (a deadlock on 2026-11-17 left no trace). */
describe("attemptCommand", () => {
  it("reports success and logs nothing", async () => {
    const warn = vi.fn();
    expect(await attemptCommand(async () => 1, who, { warn })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops a refusal by the rules without a log line", async () => {
    const warn = vi.fn();
    expect(
      await attemptCommand(
        async () => {
          throw httpError(400, "not enough wood");
        },
        who,
        { warn },
      ),
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops a database failure too, but logs it as a warning with the match and the tribe", async () => {
    const warn = vi.fn();
    const deadlock = new Error("Failed query: select ... for update: deadlock detected");
    expect(
      await attemptCommand(
        async () => {
          throw deadlock;
        },
        who,
        { warn },
      ),
    ).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([{ err: deadlock, matchId: "m1", playerId: "p1", proc: "ai" }, "ai command failed"]);
  });
});
