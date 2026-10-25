import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { registerBody } from "@lastthaw/shared";
import { buildApp } from "../src/api/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { createRedis } from "../src/redis.js";
import { nameSuffix } from "./suffix.js";

process.env.DATABASE_URL ??= "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DEV_TOOLS = "true";
process.env.SMTP_PORT ??= "1";

/** Abuse resistance: lockouts, rate limits, origin checks and malformed ids. */
describe("security", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: Db;
  const suffix = nameSuffix();
  const email = `sec-${suffix}@example.test`;
  beforeAll(async () => {
    db = createDb();
    app = await buildApp({ db, realtime: false });
    // A clean slate for the counters this test drives.
    const redis = createRedis();
    const keys = [...(await redis.keys("lt-login-fail:*")), ...(await redis.keys("lt-rl:*"))];
    if (keys.length) await redis.del(...keys);
    await redis.quit().catch(() => {});
  });
  afterAll(async () => {
    await db.delete(users).where(eq(users.email, email));
    await app.close();
    await db.close();
  });

  it("test suffixes never spell a word the name filter refuses", () => {
    // 2026-10-25: a suffix read as "b7c" (btc) refused the sign-up above with a 400.
    for (const bad of ["mvnqtb7c", "mvnqsnf7", "mvnqs87c"]) {
      vi.useFakeTimers({ now: parseInt(bad, 36), toFake: ["Date"] });
      try {
        expect(registerBody.safeParse({ email, password: "correct horse battery", displayName: `Sec ${bad}` }).success).toBe(false);
        const ok = nameSuffix();
        expect(ok).not.toBe(bad);
        expect(registerBody.safeParse({ email, password: "correct horse battery", displayName: `Sec ${ok}` }).success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("locks an account after ten wrong passwords and refuses cross-site writes and bad ids", async () => {
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, password: "correct horse battery", displayName: `Sec ${suffix}` } });
    expect(reg.statusCode).toBe(201);
    const setCookies = ([] as string[]).concat(reg.headers["set-cookie"] ?? []);
    const cookie = setCookies.map((c) => c.split(";")[0]!).join("; ");
    expect(cookie).toMatch(/lt_session=/);
    expect(cookie).toMatch(/lt_device=/);
    // A reserved or malformed tribe name is refused.
    expect((await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `x-${suffix}@example.test`, password: "correct horse battery", displayName: "Admin" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `y-${suffix}@example.test`, password: "correct horse battery", displayName: " two  spaces " } })).statusCode).toBe(400);
    // The same name, differently cased, is taken.
    expect((await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `z-${suffix}@example.test`, password: "correct horse battery", displayName: `SEC ${suffix}` } })).statusCode).toBe(409);

    for (let i = 0; i < 10; i++) {
      expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "wrong" } })).statusCode).toBe(401);
    }
    // Even the right password is refused once locked.
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "correct horse battery" } })).statusCode).toBe(429);
    // An unknown address gets the same answer as a wrong password.
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `nobody-${suffix}@example.test`, password: "whatever" } })).statusCode).toBe(401);

    // Cross-site POSTs are refused outright; same-site ones are not.
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: "http://localhost:5173" } })).statusCode).toBe(200);

    // Malformed ids are 400s, never database errors.
    expect((await app.inject({ method: "GET", url: "/api/matches/not-a-uuid/leaderboard", headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/matches/00000000-0000-0000-0000-000000000000/regions/bad!id/build", payload: { buildingId: "huts" }, headers: { cookie } })).statusCode).toBe(400);

    // The report and replay of a match that does not exist is a 404, and no login is needed to ask.
    expect((await app.inject({ method: "GET", url: "/api/matches/00000000-0000-0000-0000-000000000000/summary" })).statusCode).toBe(404);
  });

  it("rate limits the login route per address", async () => {
    let limited = false;
    for (let i = 0; i < 30 && !limited; i++) {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `rl-${suffix}@example.test`, password: "x" }, remoteAddress: "203.0.113.9" });
      if (r.statusCode === 429 && (r.json() as { error?: string }).error?.includes("Rate limit")) limited = true;
    }
    expect(limited).toBe(true);
  });
});
