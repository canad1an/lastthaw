import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql, desc } from "drizzle-orm";
import { allRegions, balance, effectsOf, fairAmount, matchStateView, regionById, RESOURCE_WORTH, scoutCatchChance, seededRng, storageCaps, findRoute, travelSeconds, unitById, techEffectsOf } from "@lastthaw/shared";
import { Publisher } from "../src/realtime/publish.js";
import { runDueJobs } from "../src/worker/jobs.js";
import { buildApp } from "../src/api/app.js";
import { forcePass } from "../src/matches/advisorsApi.js";
import { dissolveAlliances } from "../src/sim/alliances.js";
import { createDb, type Db } from "../src/db/client.js";
import { emailTokens, fairplayFlags, matches, playerActions, players, users, matchRegions, regionNotes, tradeRoutes, jobs, armies, pacts, advisors, messages, marketOrders, battles, playerTechs } from "../src/db/schema.js";
import { runMatchTicks } from "../src/sim/tick.js";
import { runTradeRoutes } from "../src/sim/trade.js";
import { detectAutomation } from "../src/fairplay/detect.js";
import { createRedis } from "../src/redis.js";
import { newToken } from "../src/auth/password.js";
import { SIM_SPEED, createSimMatch } from "../src/scripts/nightlySim.js";
import { inviteUser } from "../src/scripts/inviteUser.js";
import { sendTournamentReminders } from "../src/matches/registrations.js";
import { tournamentRegistrations } from "../src/db/schema.js";
import { chargeAdvisors, wageFor } from "../src/sim/advisors.js";
import { economyNow } from "../src/sim/ledger.js";
import { logger } from "../src/logger.js";
import { inviteMail } from "../src/mail.js";

process.env.DATABASE_URL ??= "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
// Routes are exercised as they run in production: no dev tools, so admin and beta gates are real.
process.env.DEV_TOOLS = "false";
process.env.SMTP_PORT ??= "1";

type App = Awaited<ReturnType<typeof buildApp>>;

class Client {
  cookie = "";
  constructor(private readonly app: App) {}
  async call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: Record<string, unknown>) {
    const res = await this.app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { cookie: this.cookie, ...(body ? { "content-type": "application/json" } : {}) } });
    const jar = new Map(this.cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0]!, c]));
    for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
      const pair = c.split(";")[0]!;
      jar.set(pair.split("=")[0]!, pair);
    }
    this.cookie = [...jar.values()].join("; ");
    return res;
  }
}

/** Every HTTP route, with its guards: who may call it, what it refuses, what it returns. */
describe("api routes", () => {
  // Every test calls from the same address and the same few players; the per-address request limit and the per-minute
  // command cap are reset between tests so a long suite never trips either by timing alone.
  beforeEach(async () => {
    const r = createRedis();
    try {
      const keys = [...(await r.keys("lt-rl:*")), ...(await r.keys("lt-cmd:*"))];
      if (keys.length) await r.del(...keys);
    } finally {
      await r.quit().catch(() => {});
    }
  });
  let app: App;
  let db: Db;
  const suffix = Date.now().toString(36);
  const pw = "correct horse battery";
  const admin = { email: `adm-${suffix}@example.test`, password: pw, displayName: `Adm${suffix}` };
  const ann = { email: `ann-${suffix}@example.test`, password: pw, displayName: `Ann${suffix}` };
  const ben = { email: `ben-${suffix}@example.test`, password: pw, displayName: `Ben${suffix}` };
  const outsider = { email: `out-${suffix}@example.test`, password: pw, displayName: `Out${suffix}` };
  let A: Client;
  let Ann: Client;
  let Ben: Client;
  let Out: Client;
  const created: string[] = [];
  const idOf = async (email: string) => (await db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;

  /**
   * A forced advisor pass, as the dev-only route does it (in play passes come on the advisor's own clock and nothing
   * hurries them), shaped like a reply so the checks read the same.
   */
  const forcePassAs = async (who: { email: string }, kind: "economic" | "military" | "thaw" | "chancellor", matchId: string) => {
    const redis = createRedis();
    try {
      const r = await forcePass(db, new Publisher(redis), matchId, await idOf(who.email), kind);
      return { statusCode: 200, body: JSON.stringify(r), json: () => r as unknown };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return { statusCode: err.statusCode ?? 500, body: err.message, json: () => ({ error: err.message }) as unknown };
    } finally {
      await redis.quit().catch(() => {});
    }
  };

  beforeAll(async () => {
    db = createDb();
    app = await buildApp({ db, realtime: false });
    A = new Client(app);
    Ann = new Client(app);
    Ben = new Client(app);
    Out = new Client(app);
  });
  afterAll(async () => {
    for (const id of created) await db.delete(matches).where(eq(matches.id, id));
    for (const u of [admin, ann, ben, outsider]) await db.delete(users).where(eq(users.email, u.email));
    await app.close();
    await db.close();
  });

  it("health answers without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, devTools: false });
  });

  it("the browser can report an error, which lands in the log; a malformed report is refused", async () => {
    const lines: string[] = [];
    const orig = app.log.error.bind(app.log);
    app.log.error = ((obj: unknown, msg?: string) => {
      lines.push(JSON.stringify({ obj, msg }));
      return orig(obj as never, msg as never);
    }) as typeof app.log.error;
    try {
      const res = await app.inject({ method: "POST", url: "/api/client-errors", payload: { kind: "render", message: "Cannot read properties of undefined (reading 'name')", stack: "TypeError: ...", url: "https://lastthaw.com/match/x", version: "1.03" } });
      expect(res.statusCode).toBe(204);
      expect(lines.some((l) => l.includes("client error: Cannot read properties") && l.includes('"clientError":true') && l.includes('"kind":"render"'))).toBe(true);
      expect((await app.inject({ method: "POST", url: "/api/client-errors", payload: { kind: "nope", message: "" } })).statusCode).toBe(400);
    } finally {
      app.log.error = orig as typeof app.log.error;
    }
  });

  it("register validates, refuses duplicates, and the session cookie works", async () => {
    expect((await A.call("POST", "/api/auth/register", { ...admin, password: "short" })).statusCode).toBe(400);
    expect((await A.call("POST", "/api/auth/register", { ...admin, email: "not-an-email" })).statusCode).toBe(400);
    expect((await A.call("POST", "/api/auth/register", admin)).statusCode).toBe(201);
    expect((await Ann.call("POST", "/api/auth/register", ann)).statusCode).toBe(201);
    expect((await Ben.call("POST", "/api/auth/register", ben)).statusCode).toBe(201);
    expect((await Out.call("POST", "/api/auth/register", outsider)).statusCode).toBe(201);
    expect((await new Client(app).call("POST", "/api/auth/register", ann)).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    const me = await Ann.call("GET", "/api/auth/me");
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ displayName: ann.displayName, emailVerified: false, approved: false, isAdmin: false });
    await db.update(users).set({ isAdmin: true, emailVerifiedAt: new Date() }).where(eq(users.email, admin.email));
  });

  it("login checks the password, logout ends the session", async () => {
    const c = new Client(app);
    expect((await c.call("POST", "/api/auth/login", { email: ann.email, password: "wrong password" })).statusCode).toBe(401);
    expect((await c.call("POST", "/api/auth/login", { email: `nobody-${suffix}@example.test`, password: pw })).statusCode).toBe(401);
    expect((await c.call("POST", "/api/auth/login", { email: ann.email.toUpperCase(), password: pw })).statusCode).toBe(200);
    expect((await c.call("GET", "/api/auth/me")).statusCode).toBe(200);
    expect((await c.call("POST", "/api/auth/logout", {})).statusCode).toBe(200);
    expect((await c.call("GET", "/api/auth/me")).statusCode).toBe(401);
  });

  it("email verification consumes a one-time token", async () => {
    const uid = await idOf(ann.email);
    const t = newToken();
    await db.insert(emailTokens).values({ userId: uid, kind: "verify", tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600_000) });
    expect((await Ann.call("POST", "/api/auth/verify", { token: "definitely-not-a-token" })).statusCode).toBe(400);
    expect((await Ann.call("POST", "/api/auth/verify", { token: t.token })).statusCode).toBe(200);
    expect((await Ann.call("GET", "/api/auth/me")).json()).toMatchObject({ emailVerified: true });
    expect((await Ann.call("POST", "/api/auth/verify", { token: t.token })).statusCode).toBe(400);
    // Already verified: resend is a no-op that still answers ok.
    expect((await Ann.call("POST", "/api/auth/resend-verification", {})).statusCode).toBe(200);
    // The six-digit code from the mail works too, only for the account it was sent to, and only once.
    const { issueCode } = await import("../src/auth/routes.js");
    const code = await issueCode(db, uid, 1);
    expect(code).toMatch(/^\d{6}$/);
    expect((await Ann.call("POST", "/api/auth/verify", { code: "000000" })).statusCode).toBe(400);
    expect((await Ben.call("POST", "/api/auth/verify", { code })).statusCode).toBe(400);
    expect((await Out.call("POST", "/api/auth/verify", { code })).statusCode).toBe(400);
    expect((await Ann.call("POST", "/api/auth/verify", { code })).statusCode).toBe(200);
    expect((await Ann.call("POST", "/api/auth/verify", { code })).statusCode).toBe(400);
    expect((await Ann.call("POST", "/api/auth/verify", {})).statusCode).toBe(400);
    // Ben verifies; the outsider never does, so Out stands for an account that has not confirmed its email.
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, ben.email));
  });

  it("forgot never reveals accounts; reset changes the password and ends every session", async () => {
    expect((await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: `ghost-${suffix}@example.test` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email: ben.email } })).statusCode).toBe(200);
    const uid = await idOf(ben.email);
    const t = newToken();
    await db.insert(emailTokens).values({ userId: uid, kind: "reset", tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600_000) });
    expect((await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token: t.token, password: "short" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token: t.token, password: "a brand new password" } })).statusCode).toBe(200);
    expect((await Ben.call("GET", "/api/auth/me")).statusCode).toBe(401);
    expect((await Ben.call("POST", "/api/auth/login", { email: ben.email, password: pw })).statusCode).toBe(401);
    expect((await Ben.call("POST", "/api/auth/login", { email: ben.email, password: "a brand new password" })).statusCode).toBe(200);
    ben.password = "a brand new password";
  });

  it("profile and password settings", async () => {
    expect((await Ann.call("PATCH", "/api/me/profile", { tagline: "x".repeat(200) })).statusCode).toBe(400);
    expect((await Ann.call("PATCH", "/api/me/profile", { tagline: "Ice is just slow water", location: "Yukon" })).statusCode).toBe(200);
    expect((await Ann.call("GET", "/api/auth/me")).json()).toMatchObject({ tagline: "Ice is just slow water", location: "Yukon" });
    expect((await Ann.call("POST", "/api/me/password", { currentPassword: "wrong", newPassword: "another fine password" })).statusCode).toBe(400);
    expect((await Ann.call("POST", "/api/me/password", { currentPassword: pw, newPassword: "another fine password" })).statusCode).toBe(200);
    ann.password = "another fine password";
    const c = new Client(app);
    expect((await c.call("POST", "/api/auth/login", { email: ann.email, password: ann.password })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: "/api/me/profile", payload: { tagline: "nope" } })).statusCode).toBe(401);
  });

  it("the gate is a verified email: unverified accounts see the lobby but cannot join or create; admins may still approve and revoke", async () => {
    const list = await Out.call("GET", "/api/matches");
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json())).toBe(true);
    // Out has not verified: nothing opens. Ann verified earlier: she may create.
    expect((await Out.call("POST", "/api/matches", { name: `Gate ${suffix}`, speed: 10, startsInMinutes: 0 })).statusCode).toBe(403);
    expect((await Out.call("GET", "/api/matches/name-suggestion")).statusCode).toBe(403);
    expect((await Ann.call("GET", "/api/matches/name-suggestion")).statusCode).toBe(200);
    expect((await Ann.call("GET", "/api/auth/me")).json()).toMatchObject({ approved: true });
    // Admin routes are closed to everyone else.
    for (const [method, url] of [
      ["GET", "/api/admin/users"],
      ["GET", "/api/admin/matches"],
      ["GET", "/api/admin/fairplay"],
      ["POST", "/api/admin/fairplay/scan"],
    ] as const) {
      // Admin routes do not even admit they exist to other accounts.
      expect((await Ann.call(method, url, method === "POST" ? {} : undefined)).statusCode, url).toBe(404);
      expect((await app.inject({ method, url, ...(method === "POST" ? { payload: {} } : {}) })).statusCode, url).toBe(401);
    }
    const annId = await idOf(ann.email);
    const benId = await idOf(ben.email);
    const usersList = await A.call("GET", "/api/admin/users");
    expect(usersList.statusCode).toBe(200);
    expect(JSON.stringify(usersList.json())).toContain(ann.displayName);
    // An admin's approval lets an unverified account in (invited players); revoking takes that back.
    const outId = await idOf(outsider.email);
    expect((await A.call("POST", `/api/admin/users/${outId}/approve`, {})).statusCode).toBe(200);
    expect((await Out.call("GET", "/api/auth/me")).json()).toMatchObject({ approved: true });
    expect((await A.call("POST", `/api/admin/users/${outId}/revoke`, {})).statusCode).toBe(200);
    expect((await Out.call("GET", "/api/auth/me")).json()).toMatchObject({ approved: false });
    expect((await A.call("POST", `/api/admin/users/${benId}/approve`, {})).statusCode).toBe(200);
    expect((await A.call("POST", `/api/admin/users/${annId}/approve`, {})).statusCode).toBe(200);
    // Admin rights can be handed on and taken back, but never dropped by the last admin on themselves.
    expect((await Ann.call("POST", `/api/admin/users/${benId}/admin`, { admin: true })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await A.call("POST", `/api/admin/users/${annId}/admin`, { admin: true })).statusCode).toBe(200);
    expect((await Ann.call("GET", "/api/auth/me")).json()).toMatchObject({ isAdmin: true, approved: true });
    expect((await Ann.call("POST", `/api/admin/users/${benId}/approve`, {})).statusCode).toBe(200);
    expect((await Ann.call("POST", `/api/admin/users/${annId}/admin`, { admin: false })).statusCode).toBe(400);
    expect((await A.call("POST", `/api/admin/users/${annId}/admin`, { admin: false })).statusCode).toBe(200);
    expect((await Ann.call("GET", "/api/auth/me")).json()).toMatchObject({ isAdmin: false });
    expect((await A.call("POST", `/api/admin/users/${annId}/admin`, { admin: "yes" })).statusCode).toBe(400);
  });

  it("suspension locks the account out until it is lifted", async () => {
    const outId = await idOf(outsider.email);
    expect((await A.call("POST", `/api/admin/users/${outId}/suspend`, { reason: "x" })).statusCode).toBe(400);
    expect((await A.call("POST", `/api/admin/users/${outId}/suspend`, { reason: "multi-accounting in the beta" })).statusCode).toBe(200);
    expect((await Out.call("GET", "/api/auth/me")).statusCode).toBe(401);
    expect((await Out.call("POST", "/api/auth/login", { email: outsider.email, password: pw })).statusCode).not.toBe(200);
    expect((await A.call("POST", `/api/admin/users/${outId}/unsuspend`, {})).statusCode).toBe(200);
    expect((await Out.call("POST", "/api/auth/login", { email: outsider.email, password: pw })).statusCode).toBe(200);
  });

  let gameId = "";
  let code = "";
  /**
   * Stock every region of a player's as a settled empire would be: a level-6 Storehouse everywhere and each store filled
   * to min(wanted, its cap), stamped at match time so nothing is clamped or re-gathered on the next settle. Stores are
   * capped per region (the capital holds three times more), and a day's advisor contract needs more than one base cap.
   */
  async function fillEmpire(matchId: string, playerId: string, want: { food: number; wood: number; stone: number; copper: number; iron: number }) {
    const [m] = await db.select({ clockOffsetSeconds: matches.clockOffsetSeconds, pausedAt: matches.pausedAt }).from(matches).where(eq(matches.id, matchId));
    const at = new Date((m!.pausedAt?.getTime() ?? Date.now()) + m!.clockOffsetSeconds * 1000);
    const rows = await db.select({ regionId: matchRegions.regionId, buildings: matchRegions.buildings, isCapital: matchRegions.isCapital }).from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.ownerPlayerId, playerId)));
    for (const r of rows) {
      const buildings = { ...r.buildings, storehouse: Math.max(6, r.buildings.storehouse ?? 0) };
      const caps = storageCaps(effectsOf(buildings), r.isCapital);
      await db
        .update(matchRegions)
        .set({ buildings, food: Math.min(want.food, caps.food), wood: Math.min(want.wood, caps.wood), stone: Math.min(want.stone, caps.stone), special: { copper: want.copper, iron: want.iron }, settledAt: at })
        .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, r.regionId)));
    }
  }
  it("games: a private game needs its invite code, speed and AI counts are capped, one open game at a time, and the creator may end it", async () => {
    const fast = await Ann.call("POST", "/api/matches", { name: `Fast ${suffix}`, speed: balance.match.maxGameSpeed + 1, startsInMinutes: 0, kind: "public" });
    expect(fast.statusCode, JSON.stringify(fast.json())).toBe(400);
    expect((await Ann.call("POST", "/api/matches", { name: `Crowd ${suffix}`, speed: 10, startsInMinutes: 0, kind: "public", aiFillTo: balance.match.maxAiTribes + 1 })).statusCode).toBe(400);
    expect((await Ann.call("POST", "/api/matches", { name: `Tourney ${suffix}`, speed: 1, startsInMinutes: 0, kind: "tournament" })).statusCode).toBe(403);
    expect((await Ann.call("POST", "/api/matches", { name: `Old ${suffix}`, speed: 10, startsInMinutes: 0, startsAt: new Date(Date.now() - 3600_000).toISOString(), kind: "public" })).statusCode).toBe(400);
    const priv = await Ann.call("POST", "/api/matches", { name: `Private ${suffix}`, speed: 10, startsInMinutes: 60, kind: "private", aiFillTo: 2 });
    expect(priv.statusCode, JSON.stringify(priv.json())).toBe(201);
    gameId = (priv.json() as { id: string }).id;
    code = (priv.json() as { inviteCode: string }).inviteCode;
    created.push(gameId);
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    // A private game is invisible to everyone but its creator (who sees the code) and its members.
    const row = (list: unknown) => (list as Array<{ id: string; kind?: string; inviteCode?: string | null }>).find((m) => m.id === gameId);
    expect(row((await Ben.call("GET", "/api/matches")).json())).toBeUndefined();
    const mine = row((await Ann.call("GET", "/api/matches")).json());
    expect(mine?.kind).toBe("private");
    expect(mine?.inviteCode).toBe(code);
    // The creator is in without a code; Ben needs the right one.
    expect((await Ann.call("POST", `/api/matches/${gameId}/join`, {})).statusCode).toBe(201);
    expect((await Ben.call("POST", `/api/matches/${gameId}/join`, {})).statusCode).toBe(403);
    expect((await Ben.call("POST", `/api/matches/${gameId}/join`, { inviteCode: "NOPE1234" })).statusCode).toBe(403);
    expect((await Ben.call("POST", "/api/matches/join-code", { code: "NOPE1234" })).statusCode).toBe(404);
    const found = await Ben.call("POST", "/api/matches/join-code", { code: code.toLowerCase() });
    expect(found.statusCode).toBe(200);
    expect((found.json() as { id: string }).id).toBe(gameId);
    expect((await Ben.call("POST", `/api/matches/${gameId}/join`, { inviteCode: code })).statusCode).toBe(201);
    // Joining again is harmless.
    expect((await Ben.call("POST", `/api/matches/${gameId}/join`, { inviteCode: code })).statusCode).toBe(200);
    expect((await Out.call("POST", `/api/matches/${gameId}/join`, { inviteCode: code })).statusCode).toBe(403);
    // One open game per player: Ann's private game is open, so a second is refused.
    expect((await Ann.call("POST", "/api/matches", { name: `Second ${suffix}`, speed: 10, startsInMinutes: 60, kind: "public" })).statusCode).toBe(409);
    expect((await Ann.call("POST", `/api/matches/${"00000000-0000-0000-0000-000000000000"}/join`, {})).statusCode).toBe(404);
    // The creator may end a running game early: it finishes with no winner, its report stays, and the creator is free to make another.
    const ender = await Ben.call("POST", "/api/matches", { name: `Ender ${suffix}`, speed: 10, startsInMinutes: 60, kind: "public", aiFillTo: 2 });
    expect(ender.statusCode, JSON.stringify(ender.json())).toBe(201);
    const enderId = (ender.json() as { id: string }).id;
    created.push(enderId);
    expect((await Ben.call("POST", `/api/matches/${enderId}/join`, {})).statusCode).toBe(201);
    expect((await Ben.call("POST", `/api/matches/${enderId}/end`, {})).statusCode).toBe(409);
    expect((await A.call("POST", `/api/matches/${enderId}/dev/start`, {})).statusCode).toBe(200);
    expect((await Ann.call("POST", `/api/matches/${enderId}/end`, {})).statusCode).toBe(403);
    expect((await Ben.call("POST", `/api/matches/${enderId}/end`, {})).statusCode).toBe(200);
    expect((await Ben.call("POST", `/api/matches/${enderId}/end`, {})).statusCode).toBe(409);
    const [endedRow] = await db.select().from(matches).where(eq(matches.id, enderId));
    expect(endedRow).toMatchObject({ status: "finished", winKind: "ended", winnerPlayerId: null });
    const report = (await Out.call("GET", `/api/matches/${enderId}/summary`)).json() as { match: { winKind: string | null }; story: { howWon: string; paragraphs: string[] } };
    expect(report.match.winKind).toBe("ended");
    expect(report.story.howWon).toContain("ended early");
    expect(report.story.paragraphs[0]).toContain("ended it early");
    const again = await Ben.call("POST", "/api/matches", { name: `Again ${suffix}`, speed: 10, startsInMinutes: 60, kind: "public" });
    expect(again.statusCode).toBe(201);
    created.push((again.json() as { id: string }).id);
    expect((await Ben.call("DELETE", `/api/matches/${(again.json() as { id: string }).id}`)).statusCode).toBe(200);
  });

  it("lobby: start options are far apart, picks are validated, and only admins start by hand", async () => {
    const opts = (await Ann.call("GET", `/api/matches/${gameId}/start-options`)).json() as { options: string[]; current: string | null };
    expect(opts.options.length).toBeGreaterThanOrEqual(3);
    expect(opts.current).toBeNull();
    expect(opts.options.every((id) => Math.abs(regionById(id)!.lat) <= balance.match.maxStartLatitude)).toBe(true);
    expect((await Ann.call("POST", `/api/matches/${gameId}/pick-start`, { regionId: "not-a-region" })).statusCode).toBe(400);
    expect((await Ann.call("POST", `/api/matches/${gameId}/pick-start`, { regionId: opts.options[0]! })).statusCode).toBe(200);
    expect(((await Ann.call("GET", `/api/matches/${gameId}/start-options`)).json() as { current: string | null }).current).toBe(opts.options[0]);
    // Ben is offered starts far from Ann's pick, and the game is visible to him now that he is in.
    const benOpts = (await Ben.call("GET", `/api/matches/${gameId}/start-options`)).json() as { options: string[] };
    expect(benOpts.options).not.toContain(opts.options[0]);
    expect((await Ben.call("GET", "/api/matches")).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: gameId, kind: "private", inviteCode: null })]));
    const options = opts.options.map((regionId) => ({ regionId }));
    expect((await Out.call("GET", `/api/matches/${gameId}/state`)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await Ann.call("POST", `/api/matches/${gameId}/dev/start`, {})).statusCode).toBe(404);
    expect((await A.call("POST", `/api/matches/${gameId}/dev/start`, {})).statusCode).toBe(200);
    const state = matchStateView.parse((await Ann.call("GET", `/api/matches/${gameId}/state`)).json());
    expect(state.match.status).toBe("running");
    expect(state.me.capitalRegionId).toBe(options[0]!.regionId);
    // Readable addresses: the listing carries a slug like 2026-10-private-xyz, and every match route takes it in place of the id.
    const listed = ((await Ann.call("GET", "/api/matches")).json() as Array<{ id: string; slug: string }>).find((m) => m.id === gameId)!;
    expect(listed.slug).toMatch(/^\d{4}-\d{2}-private-[a-z0-9-]+$/);
    const bySlug = matchStateView.parse((await Ann.call("GET", `/api/matches/${listed.slug}/state`)).json());
    expect(bySlug.match.id).toBe(gameId);
    expect((await Ann.call("GET", `/api/matches/${listed.slug}/leaderboard`)).statusCode).toBe(200);
    expect((await Ann.call("GET", "/api/matches/2099-01-no-such-match/state")).statusCode).toBe(404);
    expect(state.players.length).toBe(2);
    expect((await Ben.call("POST", `/api/matches/${gameId}/join`, { inviteCode: code })).statusCode).toBe(409);
  });

  it("in-match commands validate their input and ownership", async () => {
    const state = matchStateView.parse((await Ann.call("GET", `/api/matches/${gameId}/state`)).json());
    const cap = state.me.capitalRegionId!;
    const benState = matchStateView.parse((await Ben.call("GET", `/api/matches/${gameId}/state`)).json());
    const benCap = benState.me.capitalRegionId!;
    const base = `/api/matches/${gameId}`;
    // Assignments are normalised to a whole, not refused.
    expect((await Ann.call("POST", `${base}/regions/${cap}/assign`, { food: 0.5, wood: 0.5, stone: 0.5 })).statusCode).toBe(200);
    const mine = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json()).owned.find((o) => o.regionId === cap)!;
    expect(mine.assignment.food + mine.assignment.wood + mine.assignment.stone).toBeCloseTo(1);
    expect((await Ann.call("POST", `${base}/regions/${cap}/assign`, { food: 2, wood: 0, stone: 0 })).statusCode).toBe(400);
    expect((await Ann.call("POST", `${base}/regions/${benCap}/assign`, { food: 0.4, wood: 0.3, stone: 0.3 })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await Ann.call("POST", `${base}/regions/${cap}/build`, { buildingId: "castle_in_the_sky" })).statusCode).toBe(400);
    expect((await Ann.call("POST", `${base}/regions/${cap}/build`, { buildingId: "great_hearth" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("POST", `${base}/regions/${cap}/train`, { unitId: "dragon", qty: 1 })).statusCode).toBe(400);
    expect((await Ann.call("POST", `${base}/regions/${cap}/train`, { unitId: "sellsword", qty: 1 })).statusCode).toBe(400);
    {
      // Mounted units are paid for from the stores: horses hauled in serve as well as wild herds, and none in store means no chariot.
      const [annRow] = await db.select({ age: players.age, id: players.id }).from(players).where(and(eq(players.matchId, gameId), eq(players.userId, await idOf(ann.email))));
      const [capRow] = await db.select({ special: matchRegions.special, food: matchRegions.food, wood: matchRegions.wood, popWorkers: matchRegions.popWorkers }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      await db.update(players).set({ age: Math.max(1, annRow!.age) }).where(eq(players.id, annRow!.id));
      await db.insert(playerTechs).values({ matchId: gameId, playerId: annRow!.id, techId: "the_wheel", completedAt: new Date() }).onConflictDoNothing();
      await db.update(matchRegions).set({ special: { ...(capRow!.special as Record<string, number>), copper: 20, horses: 0 }, food: Math.max(capRow!.food, 500), wood: Math.max(capRow!.wood, 500), popWorkers: 30 }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      const noHorses = await Ann.call("POST", `${base}/regions/${cap}/train`, { unitId: "chariot", qty: 1 });
      expect(noHorses.statusCode, noHorses.body).toBe(409);
      expect(noHorses.body).toContain("horses");
      await db.update(matchRegions).set({ special: { ...(capRow!.special as Record<string, number>), copper: 20, horses: 2 } }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      const withHorses = await Ann.call("POST", `${base}/regions/${cap}/train`, { unitId: "chariot", qty: 1 });
      expect(withHorses.statusCode, withHorses.body).toBe(200);
      // Put Ann back as she was for the tests that follow.
      await db.update(jobs).set({ cancelledAt: new Date() }).where(and(eq(jobs.matchId, gameId), eq(jobs.playerId, annRow!.id), eq(jobs.kind, "train"), sql`${jobs.completedAt} is null`));
      await db.delete(playerTechs).where(and(eq(playerTechs.playerId, annRow!.id), eq(playerTechs.techId, "the_wheel")));
      await db.update(players).set({ age: annRow!.age }).where(eq(players.id, annRow!.id));
      await db.update(matchRegions).set({ special: capRow!.special, food: capRow!.food, wood: capRow!.wood, popWorkers: capRow!.popWorkers }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
    }
    expect((await Ann.call("POST", `${base}/research`, { techId: "warp_drive" })).statusCode).toBe(400);
    expect((await Ann.call("POST", `${base}/research`, { techId: "bronze_working" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("POST", `${base}/jobs/00000000-0000-0000-0000-000000000000/cancel`, {})).statusCode).toBe(404);
    expect((await Ann.call("POST", `${base}/regions/${cap}/send`, { mission: "raid", targetRegionId: "nowhere", units: { warrior: 1 }, people: 0, cargo: {} })).statusCode).toBe(400);
    expect((await Ann.call("POST", `${base}/regions/${cap}/send`, { mission: "raid", targetRegionId: regionById(cap)!.neighbors[0]!, units: { settler: 5 }, people: 0, cargo: {} })).statusCode).toBe(400);
    expect((await Ann.call("POST", `${base}/armies/00000000-0000-0000-0000-000000000000/recall`, {})).statusCode).toBe(404);
    expect((await Ann.call("POST", `${base}/capital`, { regionId: benCap })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("POST", `${base}/regions/${cap}/evacuate`, { toRegionId: benCap })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("POST", `${base}/regions/${cap}/convert`, { from: "caravan", to: "wagon", qty: 1 })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("POST", `${base}/regions/${cap}/disband`, { units: { warrior: 1000 } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("POST", `${base}/regions/${cap}/colonize`, { targetRegionId: benCap, settlers: 5 })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("POST", `${base}/regions/${cap}/routes`, { toRegionId: benCap, mode: "fixed", load: { food: 10 } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("PATCH", `${base}/routes/00000000-0000-0000-0000-000000000000`, { toRegionId: cap, mode: "fixed", load: {} })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("POST", `${base}/routes/00000000-0000-0000-0000-000000000000/toggle`, {})).statusCode).toBe(404);
    expect((await Ann.call("POST", `${base}/routes/00000000-0000-0000-0000-000000000000/run`, {})).statusCode).toBe(404);
    expect((await Ann.call("DELETE", `${base}/routes/00000000-0000-0000-0000-000000000000`)).statusCode).toBe(404);
    expect((await Ann.call("GET", `${base}/route`)).statusCode).toBe(400);
    const route = await Ann.call("GET", `${base}/route?from=${cap}&to=${regionById(cap)!.neighbors[0]}`);
    expect(route.statusCode).toBe(200);
    expect((route.json() as { path: string[] }).path[0]).toBe(cap);
    expect((await Ann.call("POST", `${base}/rally`, {})).statusCode).toBe(200);
    // World events and diplomacy with nothing on offer.
    expect((await Ann.call("POST", `${base}/refugees/00000000-0000-0000-0000-000000000000`, { accept: true })).statusCode).toBe(404);
    expect((await Ann.call("POST", `${base}/mercenaries/00000000-0000-0000-0000-000000000000/hire`, {})).statusCode).toBe(404);
    expect((await Ann.call("POST", `${base}/last-stand`, { targetRegionId: regionById(cap)!.neighbors[0]! })).statusCode).toBe(409);
    expect((await Ann.call("POST", `${base}/pacts`, { otherPlayerId: state.me.playerId, kind: "nap" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("POST", `${base}/pacts`, { otherPlayerId: benState.me.playerId, kind: "tribute" })).statusCode).toBe(400);
    const pact = await Ann.call("POST", `${base}/pacts`, { otherPlayerId: benState.me.playerId, kind: "ceasefire" });
    expect(pact.statusCode, JSON.stringify(pact.json())).toBe(200);
    const pactId = (pact.json() as { id: string }).id;
    expect((await Ann.call("POST", `${base}/pacts/${pactId}/respond`, { accept: true })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ben.call("POST", `${base}/pacts/${pactId}/respond`, { accept: true })).statusCode).toBe(200);
    expect((await Ann.call("POST", `${base}/pacts/${pactId}/pay`, {})).statusCode).toBeGreaterThanOrEqual(400);
    expect(matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).pacts.some((p) => p.id === pactId && p.status === "active")).toBe(true);
    // Outsiders are refused everywhere.
    expect((await Out.call("POST", `${base}/regions/${cap}/build`, { buildingId: "huts" })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await Out.call("GET", `${base}/leaderboard`)).statusCode).toBeGreaterThanOrEqual(403);
  });

  it("market, chat, messages, alliances and the feed answer for members only", async () => {
    const base = `/api/matches/${gameId}`;
    const state = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json());
    const cap = state.me.capitalRegionId!;
    const benCap = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).me.capitalRegionId!;
    expect((await Ann.call("GET", `${base}/market`)).statusCode).toBe(200);
    expect((await Ann.call("POST", `${base}/market`, { regionId: cap, offerResource: "food", offerAmount: 1_000_000, askResource: "wood", askAmount: 5 })).statusCode).toBeGreaterThanOrEqual(400);
    const order = await Ann.call("POST", `${base}/market`, { regionId: cap, offerResource: "food", offerAmount: 10, askResource: "wood", askAmount: 5 });
    expect(order.statusCode, JSON.stringify(order.json())).toBe(201);
    const orderId = (order.json() as { id: string }).id;
    expect((await Ann.call("POST", `${base}/market/${orderId}/accept`, { regionId: cap })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ben.call("POST", `${base}/market/${orderId}/cancel`, {})).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ben.call("POST", `${base}/market/${orderId}/accept`, { regionId: benCap })).statusCode).toBe(200);
    expect((await Ben.call("POST", `${base}/market/${orderId}/accept`, { regionId: benCap })).statusCode).toBeGreaterThanOrEqual(400);
    const again = await Ann.call("POST", `${base}/market`, { regionId: cap, offerResource: "food", offerAmount: 5, askResource: "stone", askAmount: 5 });
    expect(again.statusCode).toBe(201);
    expect((await Ann.call("POST", `${base}/market/${(again.json() as { id: string }).id}/cancel`, {})).statusCode).toBe(200);

    expect((await Ann.call("GET", `${base}/chat`)).statusCode).toBe(200);
    expect((await Ann.call("POST", `${base}/chat`, { channel: "global", body: "   " })).statusCode).toBe(400);
    expect((await Ann.call("POST", `${base}/chat`, { channel: "global", body: "The ice waits for no one." })).statusCode).toBe(201);
    expect((await Ann.call("POST", `${base}/chat`, { channel: "alliance", body: "secret" })).statusCode).toBeGreaterThanOrEqual(400);
    // The lobby room: everyone logged in reads, approved players write.
    expect((await app.inject({ method: "GET", url: "/api/chat/lobby" })).statusCode).toBe(401);
    expect((await Out.call("POST", "/api/chat/lobby", { body: "let me in" })).statusCode).toBe(403);
    expect((await Ann.call("POST", "/api/chat/lobby", { body: "   " })).statusCode).toBe(400);
    expect((await Ann.call("POST", "/api/chat/lobby", { body: `Anyone up for a game? ${suffix}` })).statusCode).toBe(201);
    expect((await Ann.call("POST", "/api/chat/lobby", { body: "again" })).statusCode).toBe(409);
    const lobbyChat = (await Out.call("GET", "/api/chat/lobby")).json() as { messages: { name: string; body: string }[] };
    expect(lobbyChat.messages.some((m) => m.body === `Anyone up for a game? ${suffix}` && m.name === ann.displayName)).toBe(true);
    expect(JSON.stringify((await Ben.call("GET", `${base}/chat`)).json())).toContain("The ice waits for no one.");
    expect((await Out.call("POST", `${base}/chat`, { channel: "global", body: "hi" })).statusCode).toBeGreaterThanOrEqual(403);

    const msgs = await Ann.call("GET", `${base}/messages`);
    expect(msgs.statusCode).toBe(200);
    expect((await Ann.call("POST", `${base}/messages/read`, {})).statusCode).toBe(200);

    expect((await Ann.call("GET", `${base}/alliances`)).statusCode).toBe(200);
    expect((await Ann.call("POST", `${base}/alliances`, { name: "Frost", tag: "frost" })).statusCode).toBe(400);
    const al = await Ann.call("POST", `${base}/alliances`, { name: `Frost ${suffix}`, tag: "FRST" });
    expect(al.statusCode).toBe(201);
    expect((await Ann.call("POST", `${base}/alliances/invite`, { playerId: "00000000-0000-0000-0000-000000000000" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ben.call("POST", `${base}/alliances/leave`, {})).statusCode).toBeGreaterThanOrEqual(400);
    {
      // The end of alliances: the morning it comes, every alliance dissolves, each member is told, and nothing can be founded again.
      const [mrow] = await db.select().from(matches).where(eq(matches.id, gameId));
      const ended = await db.transaction((tx) => dissolveAlliances(tx, mrow!, new Date(), null, () => {}));
      expect(ended).toBeGreaterThanOrEqual(1);
      const after = (await Ann.call("GET", `${base}/alliances`)).json() as { alliances: unknown[]; mine: unknown };
      expect(after.alliances).toHaveLength(0);
      expect(after.mine ?? null).toBeNull();
      const told = await db.select().from(messages).where(and(eq(messages.matchId, gameId), sql`${messages.payload}->>'allianceEnd' = 'true'`));
      expect(told.length).toBeGreaterThanOrEqual(1);
      expect(told[0]!.subject).toContain("has dissolved");
    }

    const presence = await Ann.call("GET", `${base}/presence`);
    expect(presence.statusCode).toBe(200);
    expect(Array.isArray((presence.json() as { online: string[] }).online)).toBe(true);
    expect((await Out.call("GET", `${base}/presence`)).statusCode).toBe(403);
    const feed = await Ann.call("GET", `${base}/feed`);
    expect(feed.statusCode).toBe(200);
    expect((feed.json() as { items: { kind: string }[] }).items.some((i) => i.kind === "match.started")).toBe(true);
    expect((await Out.call("GET", `${base}/feed`)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await Ann.call("GET", `${base}/summary`)).statusCode).toBe(200);
    expect((await Out.call("GET", `${base}/summary`)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await Ann.call("GET", `${base}/replay`)).statusCode).toBe(403);
    expect((await A.call("GET", `${base}/replay`)).statusCode).toBe(200);
  });

  it("a watchtower keeps the regions next to it in plain view, units and all", async () => {
    const base = `/api/matches/${gameId}`;
    const before = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json());
    const cap = before.me.capitalRegionId!;
    const neighbours = regionById(cap)!.neighbors;
    await db.update(matchRegions).set({ buildings: sql`${matchRegions.buildings} || '{"watchtower": 1}'::jsonb` }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
    const rows = await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), inArray(matchRegions.regionId, neighbours), sql`${matchRegions.ownerPlayerId} is distinct from ${before.me.playerId}`));
    const after = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json());
    for (const r of rows) {
      const s = after.sighted.find((x) => x.regionId === r.regionId);
      expect(s, `${r.regionId} in view`).toBeTruthy();
      expect(s!.units, `${r.regionId} units seen`).toBeDefined();
    }
    await db.update(matchRegions).set({ buildings: sql`${matchRegions.buildings} - 'watchtower'` }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
  });

  it("an admin looks into any match from outside and sees every region, army and march; others are refused", async () => {
    const base = `/api/matches/${gameId}`;
    expect((await Out.call("GET", `${base}/state`)).statusCode).toBe(404);
    const res = await A.call("GET", `${base}/state`);
    expect(res.statusCode, res.body).toBe(200);
    const god = matchStateView.parse(res.json());
    expect(god.observer).toBe(true);
    expect(god.owned).toEqual([]);
    const claimed = await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), sql`${matchRegions.ownerPlayerId} is not null`));
    expect(god.sighted.length).toBe(claimed.length);
    expect(god.sighted.every((s) => s.units !== undefined && s.ownerName !== null)).toBe(true);
    expect(god.players.length).toBeGreaterThan(0);
    expect((await A.call("GET", `${base}/messages`)).statusCode).toBe(200);
  });

  it("scouts into a garrisoned, towered region may be caught; the seeded roll decides, and both sides hear of it", async () => {
    expect(scoutCatchChance({ held: false, soldiers: 0, watchtower: false, wall: false })).toBe(0);
    expect(scoutCatchChance({ held: true, soldiers: 0, watchtower: false, wall: false })).toBeCloseTo(balance.scouting.catchBase, 6);
    expect(scoutCatchChance({ held: true, soldiers: 200, watchtower: true, wall: true })).toBe(balance.scouting.catchCap);

    // Ben scouts; Ann holds a garrison of 200 behind a palisade with a watchtower, next door to Ben's capital so the scouts can walk there.
    const base = `/api/matches/${gameId}`;
    const benState = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    const benCap = benState.me.capitalRegionId!;
    const annPlayerId = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json()).me.playerId;
    const target = regionById(benCap)!.neighbors.find((n) => !benState.owned.some((o) => o.regionId === n))!;
    await db
      .insert(matchRegions)
      .values({ matchId: gameId, regionId: target, assignment: { ...balance.start.assignment }, settledAt: new Date(), ownerPlayerId: annPlayerId, units: { warrior: 200 }, buildings: { watchtower: 1, palisade: 1 } })
      .onConflictDoUpdate({ target: [matchRegions.matchId, matchRegions.regionId], set: { ownerPlayerId: annPlayerId, units: { warrior: 200 }, buildings: { watchtower: 1, palisade: 1 } } });
    const [benRow] = await db.select({ units: matchRegions.units }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, benCap)));
    await db.update(matchRegions).set({ units: { ...benRow!.units, tracker: 3 } }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, benCap)));

    const out = await Ben.call("POST", `${base}/regions/${benCap}/send`, { mission: "scout", targetRegionId: target, units: { tracker: 3 }, people: 0, cargo: {} });
    expect(out.statusCode, out.body).toBe(200);
    const { armyId, arrivesAt } = out.json() as { armyId: string; arrivesAt: string };
    const now = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).match.now;
    // Dev tools are off in this suite, so the match clock is moved the way the time-skip route moves it.
    await db.update(matches).set({ clockOffsetSeconds: sql`${matches.clockOffsetSeconds} + ${Math.ceil((Date.parse(arrivesAt) - Date.parse(now)) / 1000) + 5}` }).where(eq(matches.id, gameId));
    const redis = createRedis();
    await runDueJobs(db, new Publisher(redis), logger);
    await redis.quit().catch(() => {});

    // The same seeded roll the server made: the match seed and the army id decide who was caught.
    const [m] = await db.select({ seed: matches.seed }).from(matches).where(eq(matches.id, gameId));
    const rng = seededRng(`${m!.seed}:scout:${armyId}`);
    let caught = 0;
    for (let i = 0; i < 3; i++) if (rng() < balance.scouting.catchCap) caught += 1;
    const name = regionById(target)!.name;
    const benInbox = ((await Ben.call("GET", `${base}/messages`)).json() as { messages: Array<{ kind: string; subject: string; payload: { regionId?: string; caught?: number } }> }).messages;
    const annInbox = ((await Ann.call("GET", `${base}/messages`)).json() as { messages: Array<{ kind: string; subject: string }> }).messages;
    const state = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    if (caught === 3) {
      expect(benInbox.find((x) => x.subject === `Your 3 scouts to ${name} never returned`)?.payload).toMatchObject({ regionId: target, caught: 3 });
      expect(annInbox.some((x) => x.subject.startsWith("3 enemy scouts from") && x.subject.endsWith(`were caught in ${name}`))).toBe(true);
      expect(state.armies.find((x) => x.id === armyId)).toBeUndefined();
      expect(state.notes.find((n) => n.regionId === target)?.text).toContain("never returned");
    } else {
      const report = benInbox.find((x) => x.subject.startsWith(`Scout report: ${name}`));
      expect(report?.payload).toMatchObject({ regionId: target, caught });
      if (caught > 0) expect(report?.subject).toContain(`${caught} of 3 did not make it`);
      const army = state.armies.find((x) => x.id === armyId)!;
      expect(army.status).toBe("returning");
      expect(army.units.tracker).toBe(3 - caught);
    }
    // The scouting wrote into Ben's notes; the notes test that follows starts from none.
    await db.delete(regionNotes).where(and(eq(regionNotes.matchId, gameId), eq(regionNotes.playerId, benState.me.playerId)));
  });

  it("a build short of materials is supplied by one collecting convoy: goods set aside at each source, idle haulers called once, a call at the second source, a build queued mid-trip riding along, delivery, and a cancel", async () => {
    const base = `/api/matches/${gameId}`;
    const benState = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    const benCap = benState.me.capitalRegionId!;
    const benPid = benState.me.playerId;
    const atMatchNow = new Date(benState.match.now);
    // Unclaimed land within two hops of the capital: S holds wood, S2 holds stone, D gets the build and holds nothing.
    const near: string[] = [];
    {
      const seen = new Set([benCap]);
      let ring = [benCap];
      for (let hop = 0; hop < 4; hop++) {
        const next: string[] = [];
        for (const id of ring) for (const n of regionById(id)?.neighbors ?? []) if (!seen.has(n)) { seen.add(n); next.push(n); near.push(n); }
        ring = next;
      }
    }
    const taken = new Set((await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), inArray(matchRegions.regionId, near), sql`${matchRegions.ownerPlayerId} is not null`))).map((r) => r.regionId));
    const free = near.filter((n) => !taken.has(n));
    expect(free.length).toBeGreaterThanOrEqual(3);
    const [S, S2, D] = free as [string, string, string];
    const claim = async (regionId: string, set: Partial<typeof matchRegions.$inferInsert>) => {
      await db
        .insert(matchRegions)
        .values({ matchId: gameId, regionId, assignment: { ...balance.start.assignment }, settledAt: atMatchNow, ownerPlayerId: benPid, popWorkers: 5, ...set })
        .onConflictDoUpdate({ target: [matchRegions.matchId, matchRegions.regionId], set: { ownerPlayerId: benPid, popWorkers: 5, settledAt: atMatchNow, ...set } });
    };
    await claim(S, { food: 500, wood: 1000, stone: 0, units: {} });
    await claim(S2, { food: 500, wood: 0, stone: 800, units: {} });
    await claim(D, { food: 100, wood: 0, stone: 0, units: {} });
    const [capRow] = await db.select({ units: matchRegions.units }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, benCap)));
    await db.update(matchRegions).set({ wood: 0, stone: 0, units: { ...capRow!.units, caravan: 6 }, settledAt: atMatchNow }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, benCap)));
    const stockAt = async (id: string) => (await db.select({ wood: matchRegions.wood, stone: matchRegions.stone }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, id))))[0]!;
    const routesTo = (id: string) => db.select().from(tradeRoutes).where(and(eq(tradeRoutes.matchId, gameId), eq(tradeRoutes.toRegionId, id)));

    const built = await Ben.call("POST", `${base}/regions/${D}/build`, { buildingId: "lumber_camp" });
    expect(built.statusCode, built.body).toBe(200);
    const { jobId } = built.json() as { jobId: string };
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    const cost = job!.waitingFor as { wood: number; stone: number };
    expect(cost.wood).toBeGreaterThan(0);
    expect(cost.stone).toBeGreaterThan(0);
    // Two routes, one per source, each with its goods set aside at once.
    const routes = await routesTo(D);
    const rS = routes.find((r) => r.fromRegionId === S)!;
    const rS2 = routes.find((r) => r.fromRegionId === S2)!;
    expect(rS).toMatchObject({ forJobId: jobId, target: { wood: cost.wood }, held: { wood: cost.wood } });
    expect(rS2).toMatchObject({ forJobId: jobId, target: { stone: cost.stone }, held: { stone: cost.stone } });
    expect(Math.round((await stockAt(S)).wood)).toBe(1000 - cost.wood);
    expect(Math.round((await stockAt(S2)).stone)).toBe(800 - cost.stone);

    const redis = createRedis();
    const pub = new Publisher(redis);
    const skip = async (iso: string) => {
      const now = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).match.now;
      const secs = Math.ceil((Date.parse(iso) - Date.parse(now)) / 1000) + 5;
      if (secs > 0) await db.update(matches).set({ clockOffsetSeconds: sql`${matches.clockOffsetSeconds} + ${secs}` }).where(eq(matches.id, gameId));
      await runDueJobs(db, pub, logger);
    };
    try {
      // First run: neither source has haulers; exactly one relief convoy is called, the other route waits for it.
      await runTradeRoutes(db, pub, logger);
      const relief = await db.select().from(armies).where(and(eq(armies.matchId, gameId), eq(armies.playerId, benPid), eq(armies.mission, "move"), eq(armies.status, "outbound")));
      expect(relief.length).toBe(1);
      expect(relief[0]!.units).toEqual({ caravan: 1 });
      const after1 = await routesTo(D);
      expect(after1.map((r) => r.lastResult ?? "").filter((x) => x.startsWith("waiting for the convoy from")).length).toBe(1);

      // The haulers arrive; the next run sends one convoy that loads here and calls at the other source on the way.
      await skip(relief[0]!.arrivesAt.toISOString());
      await runTradeRoutes(db, pub, logger);
      const [convoy] = await db.select().from(armies).where(and(eq(armies.matchId, gameId), eq(armies.playerId, benPid), eq(armies.mission, "transport"), eq(armies.status, "outbound")));
      expect(convoy).toBeDefined();
      const start = convoy!.stops[0]!.regionId;
      const other = start === S ? S2 : S;
      expect(convoy!.stops.map((s) => s.regionId)).toEqual([start, other, D]);
      expect(convoy!.stops[0]!.done).toBe(true);
      expect(convoy!.targetRegionId).toBe(other);
      // Everything promised has left the holds, onto the manifest.
      for (const r of await routesTo(D)) expect(Object.values(r.held).every((v) => v === 0)).toBe(true);

      // While the worker holds the convoy (resolving its arrival, which then locks a region), a build request holding a
      // source region must not wait for it: the convoy is skipped and the goods stay in the hold. Waiting deadlocked on production.
      {
        const { placeOnConvoys } = await import("../src/sim/commands.js");
        const [mrow] = await db.select().from(matches).where(eq(matches.id, gameId));
        let release!: () => void;
        const released = new Promise<void>((r) => (release = r));
        let locked!: () => void;
        const isLocked = new Promise<void>((r) => (locked = r));
        const holder = db.transaction(async (tx) => {
          await tx.select().from(armies).where(eq(armies.id, convoy!.id)).for("update");
          locked();
          await released;
        });
        await isLocked;
        try {
          const placed = await db.transaction(async (tx) => {
            await tx.execute(sql`set local lock_timeout = '3s'`);
            return placeOnConvoys(tx, mrow!, benPid, convoy!.stops[1]!.routeId ?? "r", other, D, { wood: 1, stone: 1 }, new Set());
          });
          expect(placed).toEqual({});
        } finally {
          release();
          await holder;
        }
        const [same] = await db.select().from(armies).where(eq(armies.id, convoy!.id));
        expect(same!.stops).toEqual(convoy!.stops);
      }

      // A build queued while the convoy is still collecting: its stone rides along on the pending call, its wood waits for the next convoy.
      const nowIso = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).match.now;
      // (D and the capital gathered a little while the haulers travelled; empty both so the goods come from S and S2 again.)
      await db.update(matchRegions).set({ wood: 0, stone: 0, settledAt: new Date(nowIso) }).where(and(eq(matchRegions.matchId, gameId), inArray(matchRegions.regionId, [D, benCap])));
      // Each source gathered a little of the other's resource meanwhile; clear that so each can only supply its own, and the split is known.
      await db.update(matchRegions).set({ [start === S ? "stone" : "wood"]: 0, settledAt: new Date(nowIso) }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, start)));
      await db.update(matchRegions).set({ [other === S ? "stone" : "wood"]: 0, settledAt: new Date(nowIso) }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, other)));
      const built2 = await Ben.call("POST", `${base}/regions/${D}/build`, { buildingId: "lumber_camp" });
      expect(built2.statusCode, built2.body).toBe(200);
      const job2 = (built2.json() as { jobId: string }).jobId;
      const [j2] = await db.select().from(jobs).where(eq(jobs.id, job2));
      const cost2 = j2!.waitingFor as { wood: number; stone: number };
      const [convoy2] = await db.select().from(armies).where(eq(armies.id, convoy!.id));
      const pendingStop = convoy2!.stops.find((s) => s.regionId === other && !s.done)!;
      expect(convoy2!.stops.map((s) => s.regionId), JSON.stringify({ stops: convoy2!.stops, routes: (await routesTo(D)).map((r) => ({ from: r.fromRegionId, held: r.held, target: r.target })) })).toEqual([start, other, D]);
      const otherRes = other === S2 ? "stone" : "wood";
      const otherCost = other === S2 ? cost2.stone : cost2.wood;
      // Whatever the other source was asked for (the regions gathered a little meanwhile, so the split can vary) is all on the pending call, none left in its hold.
      const rOther = (await routesTo(D)).find((r) => r.fromRegionId === other)!;
      expect(rOther.target![otherRes]).toBeGreaterThan(other === S2 ? cost.stone : cost.wood);
      expect(pendingStop.take[otherRes]).toBe(rOther.target![otherRes]);
      expect(Object.values(rOther.held).every((v) => v === 0)).toBe(true);
      void otherCost;
      // The start was already called at, so its share for the second build waits in its hold for the next convoy.
      const rStart = (await routesTo(D)).find((r) => r.fromRegionId === start)!;
      const startHeld = Object.fromEntries(Object.entries(rStart.held).filter(([, v]) => v > 0)) as Record<string, number>;
      expect(Object.keys(startHeld).length).toBeGreaterThan(0);

      // The call, then the delivery: the first build starts, the second still waits for what the next convoy brings.
      await skip(convoy2!.arrivesAt.toISOString());
      const [convoy3] = await db.select().from(armies).where(eq(armies.id, convoy!.id));
      expect(convoy3!.targetRegionId).toBe(D);
      expect(convoy3!.cargo[otherRes]).toBe(rOther.target![otherRes]);
      await skip(convoy3!.arrivesAt.toISOString());
      const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      expect(after!.waitingFor).toBeNull();
      const [after2] = await db.select().from(jobs).where(eq(jobs.id, job2));
      expect(after2!.waitingFor).toEqual(startHeld);

      // Cancelling the second build puts its waiting goods back on the shelf at the source and drops that route.
      // Settle the source first: the cancel settles hours of production before refunding, which would otherwise swamp the comparison.
      const { settleAndLockRegion } = await import("../src/sim/regions.js");
      const [mrow] = await db.select().from(matches).where(eq(matches.id, gameId));
      const settledIso = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).match.now;
      await db.transaction((tx) => settleAndLockRegion(tx, gameId, start, new Date(settledIso), mrow!.speed));
      const before = await stockAt(start);
      expect((await Ben.call("POST", `${base}/jobs/${job2}/cancel`, {})).statusCode).toBe(200);
      const restored = await stockAt(start);
      for (const [k, v] of Object.entries(startHeld)) expect(Math.round(restored[k as "wood" | "stone"] - before[k as "wood" | "stone"])).toBe(v);
      expect((await routesTo(D)).filter((r) => r.forJobId === job2)).toEqual([]);
    } finally {
      await redis.quit().catch(() => {});
    }
  });

  it("a force marching on land that becomes yours before it arrives stays there: soldiers garrison it and settlers join the occupiers", async () => {
    const base = `/api/matches/${gameId}`;
    // Ben attacks a region of Ann's; the pact from the diplomacy test would forbid it, so it is cleared.
    await db.delete(pacts).where(eq(pacts.matchId, gameId));
    const benState = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    const annCap = benState.me.capitalRegionId!;
    const annPid = benState.me.playerId;
    const atMatchNow = new Date(benState.match.now);
    const Attacker = Ben;
    // A free neighbour of the attacker's capital, given to the other player as the target.
    const near: string[] = [];
    {
      const seen = new Set([annCap]);
      let ring = [annCap];
      for (let hop = 0; hop < 3; hop++) {
        const next: string[] = [];
        for (const id of ring) for (const n of regionById(id)?.neighbors ?? []) if (!seen.has(n)) { seen.add(n); next.push(n); near.push(n); }
        ring = next;
      }
    }
    const taken = new Set((await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), inArray(matchRegions.regionId, near), sql`${matchRegions.ownerPlayerId} is not null`))).map((r) => r.regionId));
    const R = near.find((n) => !taken.has(n))!;
    expect(R).toBeTruthy();
    await db
      .insert(matchRegions)
      // A neutral tribe holds it (a player's region would be under beginner protection in this young match).
      .values({ matchId: gameId, regionId: R, assignment: { ...balance.start.assignment }, settledAt: atMatchNow, ownerPlayerId: null, popWorkers: 5, units: { warrior: 2 } })
      .onConflictDoUpdate({ target: [matchRegions.matchId, matchRegions.regionId], set: { ownerPlayerId: null, popWorkers: 5, settledAt: atMatchNow, units: { warrior: 2 }, popOccupiers: 0 } });
    const [cap] = await db.select({ units: matchRegions.units }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, annCap)));
    await db.update(matchRegions).set({ units: { ...cap!.units, warrior: 5, settler: 5 }, settledAt: atMatchNow }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, annCap)));
    const out = await Attacker.call("POST", `${base}/regions/${annCap}/send`, { mission: "conquer", targetRegionId: R, units: { warrior: 5, settler: 5 }, people: 0, cargo: {} });
    expect(out.statusCode, out.body).toBe(200);
    const { armyId, arrivesAt } = out.json() as { armyId: string; arrivesAt: string };
    // Before the force arrives, the region comes over to the attacker (as the fall of the owner's capital would hand it).
    await db.update(matchRegions).set({ ownerPlayerId: annPid, conquered: true, loyalty: balance.conquest.startingLoyalty }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, R)));
    const now = matchStateView.parse((await Attacker.call("GET", `${base}/state`)).json()).match.now;
    await db.update(matches).set({ clockOffsetSeconds: sql`${matches.clockOffsetSeconds} + ${Math.ceil((Date.parse(arrivesAt) - Date.parse(now)) / 1000) + 5}` }).where(eq(matches.id, gameId));
    const redis = createRedis();
    await runDueJobs(db, new Publisher(redis), logger);
    await redis.quit().catch(() => {});
    const [army] = await db.select().from(armies).where(eq(armies.id, armyId));
    expect(army?.status).toBe("done");
    const [row] = await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, R)));
    expect(row?.ownerPlayerId).toBe(annPid);
    expect(row?.units.warrior).toBeGreaterThanOrEqual(5);
    expect(row?.popOccupiers).toBe(5);
    const inbox = ((await Attacker.call("GET", `${base}/messages`)).json() as { messages: Array<{ subject: string }> }).messages;
    expect(inbox.some((x) => x.subject.startsWith("5 settlers joined the occupiers in"))).toBe(true);
  });

  it("the Economic advisor: hired and fired for an hourly wage with no fee, raises buildings to the minimums set, balances people, is charged by the tick, stops when unpaid, and moves nobody when not hired", async () => {
    const base = `/api/matches/${gameId}`;
    const benState = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    const cap = benState.me.capitalRegionId!;
    const benPid = benState.me.playerId;
    const nowIso = async () => matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).match.now;
    const stockAt = async (id: string) => (await db.select({ food: matchRegions.food, wood: matchRegions.wood, stone: matchRegions.stone, special: matchRegions.special }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, id))))[0]!;
    // Stores are capped per region (the capital holds three times more), so every region of Ben's is filled and the contract is measured across them.
    const fill = (food: number, wood: number, stone: number, copper: number, iron: number) => fillEmpire(gameId, benPid, { food, wood, stone, copper, iron });
    const totalStock = async () => {
      const rows = await db.select({ food: matchRegions.food, wood: matchRegions.wood, stone: matchRegions.stone, special: matchRegions.special }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid)));
      return rows.reduce((a, r) => ({ food: a.food + r.food, wood: a.wood + r.wood, stone: a.stone + r.stone, copper: a.copper + ((r.special as { copper?: number }).copper ?? 0) }), { food: 0, wood: 0, stone: 0, copper: 0 });
    };
    // A wage is paid by value in any mix of food, wood and stone, so the books are checked by worth, not by one resource.
    const worthOf = (w: Record<string, number | undefined>) => Object.entries(w).reduce((a, [k, v]) => a + (v ?? 0) * (RESOURCE_WORTH[k] ?? 1), 0);
    const valueDrop = (b: { food: number; wood: number; stone: number }, a: { food: number; wood: number; stone: number }) => worthOf({ food: b.food - a.food, wood: b.wood - a.wood, stone: b.stone - a.stone });
    const redis = createRedis();
    const pub = new Publisher(redis);
    try {
      // Hire: nothing leaves the stores; a second hire is refused.
      await fill(12000, 12000, 9000, 100, 100);
      const regions = (await db.select({ n: sql<number>`count(*)::int` }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid), sql`${matchRegions.frozenAt} is null`)))[0]!.n;
      const before = await totalStock();
      const hired = await Ben.call("POST", `${base}/advisors/economic/hire`, {});
      expect(hired.statusCode, hired.body).toBe(200);
      // The wage is a share of the empire's live output: positive in what it gathers, and what the server charged.
      const wage = (hired.json() as { wage: Record<string, number> }).wage;
      expect(wage.food).toBeGreaterThan(0);
      expect(wage.wood).toBeGreaterThan(0);
      expect(wage.copper ?? 0).toBeGreaterThanOrEqual(0);
      const after = await totalStock();
      // Nothing is paid up front: the first hour is charged by the tick like every other.
      expect(Math.round(before.food - after.food)).toBe(0);
      expect(Math.round(before.wood - after.wood)).toBe(0);
      expect(Math.round(before.copper - after.copper)).toBe(0);
      expect((await Ben.call("POST", `${base}/advisors/economic/hire`, {})).statusCode).toBe(409);
      // Nobody can hurry an advisor in play: the forced-pass route exists only with dev tools on.
      expect((await Ben.call("POST", `${base}/advisors/economic/run`, {})).statusCode).toBe(404);
      let st = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
      expect(st.advisors).toHaveLength(1);
      expect(st.advisors[0]).toMatchObject({ kind: "economic", unpaid: false, wage, settings: { population: "overflow", useOtherRegions: true } });

      // Settings: validated, then stored.
      expect((await Ben.call("PUT", `${base}/advisors/economic/settings`, { minLevels: { huts: 99 } })).statusCode).toBe(400);
      expect((await Ben.call("PUT", `${base}/advisors/economic/settings`, { minLevels: { quarry: 1 }, useOtherRegions: true, skipRegions: [], population: "balanced" })).statusCode).toBe(200);
      st = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
      expect(st.advisors[0]!.settings).toMatchObject({ minLevels: { quarry: 1 }, population: "balanced" });

      // A pass: a Quarry is queued wherever one is missing and can stand; a second pass straight away is refused.
      const lacking = st.owned.filter((o) => !(o.buildings.quarry ?? 0)).length;
      expect(lacking).toBeGreaterThan(0);
      // Passes wait for the first hour's wage: hiring is free, so nothing runs until the tick has charged it.
      const early = await forcePassAs(ben, "economic", gameId);
      expect(early.statusCode, early.body).toBe(409);
      {
        const at = new Date(await nowIso());
        const [mrow] = await db.select().from(matches).where(eq(matches.id, gameId));
        await db.transaction((tx) => chargeAdvisors(tx, mrow!, at));
      }
      const run = await forcePassAs(ben, "economic", gameId);
      expect(run.statusCode, run.body).toBe(200);
      const report = (run.json() as { report: { queued: number; skipped: Record<string, number> } }).report;
      expect(report.queued).toBeGreaterThan(0);
      const quarryJobs = await db.select().from(jobs).where(and(eq(jobs.matchId, gameId), eq(jobs.playerId, benPid), eq(jobs.kind, "build"), eq(jobs.refId, "quarry"), sql`${jobs.completedAt} is null`, sql`${jobs.cancelledAt} is null`));
      expect(quarryJobs.length).toBe(report.queued);
      expect((await forcePassAs(ben, "economic", gameId)).statusCode).toBe(429);

      // Workers: a capital gathering no food while its store is nearly empty is put back on food by the next pass; a store near its cap gets no more.
      const [capRow] = await db.select({ buildings: matchRegions.buildings, isCapital: matchRegions.isCapital }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      const capCaps = storageCaps(effectsOf(capRow!.buildings), capRow!.isCapital);
      await db.update(matchRegions).set({ assignment: { food: 0, wood: 0.5, stone: 0.5 }, food: 20, wood: Math.floor(capCaps.wood * 0.97), stone: Math.floor(capCaps.stone * 0.97), settledAt: new Date(await nowIso()) }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      await db.update(advisors).set({ lastPassAt: null }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid)));
      const runW = await forcePassAs(ben, "economic", gameId);
      expect(runW.statusCode, runW.body).toBe(200);
      expect((runW.json() as { report: { rebalanced: number } }).report.rebalanced).toBeGreaterThan(0);
      const [capAfter] = await db.select({ assignment: matchRegions.assignment }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      expect(capAfter!.assignment.food).toBeGreaterThanOrEqual(0.5);
      expect(capAfter!.assignment.stone).toBeLessThanOrEqual(0.2);
      await fill(12000, 12000, 9000, 100, 100);

      // Balanced people: a swollen capital sends a column to an emptier region of Ben's.
      await db.update(matchRegions).set({ popWorkers: 600, settledAt: new Date(await nowIso()) }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      await db.update(advisors).set({ lastPassAt: null }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid)));
      const run2 = await forcePassAs(ben, "economic", gameId);
      expect(run2.statusCode, run2.body).toBe(200);
      expect((run2.json() as { report: { moved: number } }).report.moved).toBeGreaterThan(0);
      const columns = await db.select().from(armies).where(and(eq(armies.matchId, gameId), eq(armies.playerId, benPid), eq(armies.mission, "move"), eq(armies.status, "outbound"), eq(armies.originRegionId, cap)));
      expect(columns.some((a) => (a.cargo.people ?? 0) > 0)).toBe(true);

      // The tick charges every whole hour past paidUntil.
      const tickOnce = async () => {
        await db.update(matches).set({ lastTickAt: new Date(Date.now() - 3600_000) }).where(eq(matches.id, gameId));
        await runMatchTicks(db, pub, logger);
      };
      await fill(12000, 12000, 9000, 100, 100);
      await db.update(advisors).set({ paidUntil: new Date(Date.parse(await nowIso()) - 2 * (3600_000 / benState.match.speed)) }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid)));
      // The wage is live: what the empire gathers now, not what it gathered at the hire.
      const liveWage = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).advisorWage;
      const b2 = await totalStock();
      await tickOnce();
      const [row] = await db.select().from(advisors).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid)));
      expect(row!.paidUntil.getTime()).toBeGreaterThan(Date.parse(await nowIso()) - 1000);
      expect(row!.unpaidSince).toBeNull();
      const a2 = await totalStock();
      // Three hours came due (two past plus the one just reached): the stores fell by at least two wages' worth, and not by more than four.
      expect(valueDrop(b2, a2)).toBeGreaterThanOrEqual(2 * worthOf(liveWage) - 1);
      expect(valueDrop(b2, a2)).toBeLessThan(4 * worthOf(liveWage) + 50);

      // Any mix: with no food at all but wood and stone to spare, the hour is paid from those and the advisor carries on.
      await db.update(matchRegions).set({ food: 0, settledAt: new Date(await nowIso()) }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid)));
      await db.update(advisors).set({ paidUntil: new Date(Date.parse(await nowIso()) - 3600_000 / benState.match.speed) }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid)));
      const bMix = await totalStock();
      await tickOnce();
      const aMix = await totalStock();
      expect((await db.select({ unpaidSince: advisors.unpaidSince }).from(advisors).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid))))[0]!.unpaidSince).toBeNull();
      expect(valueDrop(bMix, aMix)).toBeGreaterThanOrEqual(worthOf(liveWage) * 0.5);
      expect(bMix.wood - aMix.wood).toBeGreaterThan(0);

      // Unpaid: an empire with nothing in store cannot pay; the advisor stops, says so once, and refuses to run.
      await db.update(matchRegions).set({ food: 0, wood: 0, stone: 0, settledAt: new Date(await nowIso()) }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid)));
      await db.update(advisors).set({ paidUntil: new Date(Date.parse(await nowIso()) - 3600_000 / benState.match.speed) }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid)));
      await tickOnce();
      const [row2] = await db.select().from(advisors).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid)));
      expect(row2!.unpaidSince).not.toBeNull();
      expect((await forcePassAs(ben, "economic", gameId)).statusCode).toBe(409);
      const told = await db.select().from(messages).where(and(eq(messages.matchId, gameId), eq(messages.playerId, benPid), sql`${messages.payload}->>'unpaid' = 'true'`));
      expect(told.length).toBe(1);
      // Paid again: back at work.
      await fill(12000, 12000, 9000, 100, 100);
      await tickOnce();
      const [row3] = await db.select().from(advisors).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid)));
      expect(row3!.unpaidSince).toBeNull();

      // Fire: nothing refunded, and no rehire until a day has passed; then rehire works and keeps the settings.
      expect((await Ben.call("POST", `${base}/advisors/economic/fire`, {})).statusCode).toBe(200);
      st = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
      expect(st.advisors).toEqual([]);
      const tooSoon = await Ben.call("POST", `${base}/advisors/economic/hire`, {});
      expect(tooSoon.statusCode).toBe(409);
      expect(tooSoon.body).toContain("take you back");
      await db.update(advisors).set({ firedAt: new Date(Date.parse(await nowIso()) - (balance.advisors.rehireCooldownHours + 1) * (3600_000 / benState.match.speed)) }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid), eq(advisors.kind, "economic")));
      // A swollen capital gathers so much that a day's wage would outgrow the stores: thin it before rehiring.
      await db.update(matchRegions).set({ popWorkers: 150 }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid), sql`${matchRegions.popWorkers} > 150`));
      await fill(12000, 12000, 9000, 100, 100);
      let rehireWage: Record<string, number> = {};
      {
        const rehired = await Ben.call("POST", `${base}/advisors/economic/hire`, {});
        expect(rehired.statusCode, rehired.body).toBe(200);
        rehireWage = (rehired.json() as { wage: Record<string, number> }).wage;
      }
      st = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
      expect(st.advisors[0]!.settings.minLevels).toEqual({ quarry: 1 });
      // Fired before the first hour was ever charged: that hour is billed on the way out, so a hire and a firing are never free.
      const bFire = await totalStock();
      const fired = await Ben.call("POST", `${base}/advisors/economic/fire`, {});
      expect(fired.statusCode, fired.body).toBe(200);
      const charged = (fired.json() as { charged: Record<string, number> }).charged;
      expect(Math.abs(worthOf(charged) - worthOf(rehireWage))).toBeLessThan(1);
      const aFire = await totalStock();
      // Production accrues between the two readings, so the drop is checked within a small band.
      expect(valueDrop(bFire, aFire)).toBeGreaterThanOrEqual(worthOf(rehireWage) - 50);
      expect(valueDrop(bFire, aFire)).toBeLessThan(worthOf(rehireWage) + 50);
      await db.update(advisors).set({ firedAt: new Date(Date.parse(await nowIso()) - (balance.advisors.rehireCooldownHours + 1) * (3600_000 / benState.match.speed)) }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid), eq(advisors.kind, "economic")));

      // No advisor: a crowded capital stays crowded through a tick; with one set to overflow, the surplus spills to a neighbour.
      await db.update(matchRegions).set({ popWorkers: 600, settledAt: new Date(await nowIso()) }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      await tickOnce();
      const [still] = await db.select({ popWorkers: matchRegions.popWorkers }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      expect(Math.round(still!.popWorkers)).toBeGreaterThanOrEqual(590);
      // A swollen capital gathers so much that a day's wage would outgrow the stores: thin it before rehiring.
      await db.update(matchRegions).set({ popWorkers: 150 }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid), sql`${matchRegions.popWorkers} > 150`));
      await fill(12000, 12000, 9000, 100, 100);
      {
        const rehired = await Ben.call("POST", `${base}/advisors/economic/hire`, {});
        expect(rehired.statusCode, rehired.body).toBe(200);
      }
      // Rehiring keeps the old settings (balanced); overflow is what this step checks.
      expect((await Ben.call("PUT", `${base}/advisors/economic/settings`, { population: "overflow" })).statusCode).toBe(200);
      await db.update(matchRegions).set({ popWorkers: 600 }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      await tickOnce();
      const [spilled] = await db.select({ popWorkers: matchRegions.popWorkers }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
      expect(spilled!.popWorkers).toBeLessThan(still!.popWorkers);
      expect((await Ben.call("POST", `${base}/advisors/economic/fire`, {})).statusCode).toBe(200);
    } finally {
      await redis.quit().catch(() => {});
    }
  });

  it("the Military advisor: hired for his wage, garrisons and fortifies the border, and runs a campaign from scouting through muster to the conquest of a marked region", async () => {
    const base = `/api/matches/${gameId}`;
    await db.delete(pacts).where(eq(pacts.matchId, gameId));
    const benState = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    const cap = benState.me.capitalRegionId!;
    const benPid = benState.me.playerId;
    const nowIso = async () => matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).match.now;
    const fillCap = () => fillEmpire(gameId, benPid, { food: 6000, wood: 12000, stone: 10000, copper: 100, iron: 120 });
    // A weak neutral tribe on free land next to one of Ben's regions: the target.
    const ownedIds = benState.owned.map((o) => o.regionId);
    const around = [...new Set(ownedIds.flatMap((id) => regionById(id)?.neighbors ?? []))].filter((n) => !ownedIds.includes(n));
    const taken = new Set((await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), inArray(matchRegions.regionId, around), sql`${matchRegions.ownerPlayerId} is not null`))).map((r) => r.regionId));
    const N = around.find((n) => !taken.has(n))!;
    expect(N).toBeTruthy();
    const adj = ownedIds.find((id) => regionById(id)?.neighbors.includes(N))!;
    await db
      .insert(matchRegions)
      .values({ matchId: gameId, regionId: N, assignment: { ...balance.start.assignment }, settledAt: new Date(await nowIso()), ownerPlayerId: null, popWorkers: 0, units: { warrior: 1 } })
      .onConflictDoUpdate({ target: [matchRegions.matchId, matchRegions.regionId], set: { ownerPlayerId: null, popWorkers: 0, units: { warrior: 1 }, popOccupiers: 0, popSoldiers: 0, settledAt: new Date(await nowIso()) } });
    await fillCap();
    const [capRow] = await db.select({ units: matchRegions.units, buildings: matchRegions.buildings }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
    await db.update(matchRegions).set({ units: { ...capRow!.units, tracker: 2 }, popWorkers: 60 }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
    const redis = createRedis();
    const pub = new Publisher(redis);
    const skip = async (iso: string) => {
      const now = await nowIso();
      const secs = Math.ceil((Date.parse(iso) - Date.parse(now)) / 1000) + 5;
      if (secs > 0) await db.update(matches).set({ clockOffsetSeconds: sql`${matches.clockOffsetSeconds} + ${secs}` }).where(eq(matches.id, gameId));
      await runDueJobs(db, pub, logger);
    };
    type Campaign = { targetRegionId: string; stage: string; armyId: string | null; need: { qty: number; settlers: number } | null; note: string };
    const pass = async () => {
      await db.update(advisors).set({ lastPassAt: null }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid), eq(advisors.kind, "military")));
      const r = await forcePassAs(ben, "military", gameId);
      expect(r.statusCode, r.body).toBe(200);
      const [row] = await db.select().from(advisors).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid), eq(advisors.kind, "military")));
      return { report: (r.json() as { report: { trained: number; fortified: number; exposed: Array<{ regionId: string }>; skipped: Record<string, number> } }).report, campaigns: row!.campaigns as unknown as Campaign[] };
    };
    try {
      // Hire: his wage leaves the capital.
      const regions = (await db.select({ n: sql<number>`count(*)::int` }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid), sql`${matchRegions.frozenAt} is null`)))[0]!.n;
      const hired = await Ben.call("POST", `${base}/advisors/military/hire`, {});
      expect(hired.statusCode, hired.body).toBe(200);
      {
        // The wage is food, wood and stone only. A mine on an ore region puts ore into the gross output, and it still stays out
        // of the wage; with every ore and horse store at zero the hourly charge clears, so a short ore never stops an advisor.
        // Ben is lent an unclaimed copper region with a mine for the check, and gives it back after.
        const claimed = new Set((await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), sql`${matchRegions.ownerPlayerId} is not null`))).map((r) => r.regionId));
        const oreRegion = allRegions().find((r) => r.resources.includes("copper") && !claimed.has(r.id))?.id;
        expect(oreRegion, "no free copper region on the map").toBeTruthy();
        await db
          .insert(matchRegions)
          .values({ matchId: gameId, regionId: oreRegion!, ownerPlayerId: benPid, assignment: { ...balance.start.assignment }, settledAt: new Date(await nowIso()), popWorkers: 40, buildings: { mine: 3 } })
          .onConflictDoUpdate({ target: [matchRegions.matchId, matchRegions.regionId], set: { ownerPlayerId: benPid, popWorkers: 40, buildings: { mine: 3 }, settledAt: new Date(await nowIso()) } });
        const [mrow] = await db.select().from(matches).where(eq(matches.id, gameId));
        const gross = (await economyNow(db, mrow!, benPid)).gross;
        expect(["copper", "tin", "iron"].some((k) => (gross[k] ?? 0) > 0), JSON.stringify(gross)).toBe(true);
        const wage = await wageFor(db, mrow!, benPid);
        expect(Object.keys(wage).sort()).toEqual(["food", "stone", "wood"]);
        await db.update(matchRegions).set({ special: { copper: 0, tin: 0, iron: 0, horses: 0 } }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid)));
        await fillCap();
        await db.update(advisors).set({ paidUntil: new Date(Date.parse(await nowIso()) - 1000) }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid), eq(advisors.kind, "military")));
        const chargeAt = new Date(await nowIso());
        await db.transaction((tx) => chargeAdvisors(tx, mrow!, chargeAt));
        const [charged] = await db.select({ unpaidSince: advisors.unpaidSince, paidUntil: advisors.paidUntil }).from(advisors).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid), eq(advisors.kind, "military")));
        expect(charged!.unpaidSince).toBeNull();
        await db.update(matchRegions).set({ ownerPlayerId: null, popWorkers: 0, buildings: {} }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, oreRegion!)));
      }
      expect((hired.json() as { wage: Record<string, number> }).wage.food).toBeGreaterThan(0);
      expect((await Ben.call("PUT", `${base}/advisors/military/settings`, { stance: "measured", garrison: 4, fortify: true, scoutFirst: true })).statusCode).toBe(200);
      // The target is marked from the map; own land is refused.
      expect((await Ben.call("POST", `${base}/advisors/military/targets`, { regionId: cap, add: true })).statusCode).toBe(400);
      const marked = await Ben.call("POST", `${base}/advisors/military/targets`, { regionId: N, add: true });
      expect(marked.statusCode, marked.body).toBe(200);
      const st = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
      expect(st.advisors.find((a) => a.kind === "military")?.settings.targets).toEqual([N]);

      // Pass 1: the capital is on the front, so it gets soldiers and a tower; the campaign opens with scouts.
      const p1 = await pass();
      expect(p1.report.exposed.some((e) => e.regionId === adj)).toBe(true);
      expect(p1.report.trained).toBeGreaterThan(0);
      expect(p1.report.fortified).toBeGreaterThan(0);
      const c1 = p1.campaigns.find((c) => c.targetRegionId === N)!;
      expect(c1.stage, c1.note).toBe("intel");
      const [scouts] = await db.select().from(armies).where(and(eq(armies.matchId, gameId), eq(armies.playerId, benPid), eq(armies.mission, "scout"), eq(armies.targetRegionId, N), eq(armies.status, "outbound")));
      expect(scouts).toBeDefined();

      // The sighting lands; pass 2 musters at the capital and orders what is missing.
      await skip(scouts!.arrivesAt.toISOString());
      await fillCap();
      const p2 = await pass();
      const c2 = p2.campaigns.find((c) => c.targetRegionId === N)!;
      expect(c2.stage, c2.note).toBe("muster");
      expect(c2.need!.qty).toBeGreaterThanOrEqual(3);
      expect(c2.need!.settlers).toBe(balance.conquest.occupiersRequired);

      // The force is at hand where he musters: pass 3 marches.
      const staging = (p2.campaigns.find((c) => c.targetRegionId === N) as unknown as { stagingRegionId: string }).stagingRegionId;
      const [stagingNow] = await db.select({ units: matchRegions.units }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, staging)));
      await db.update(matchRegions).set({ units: { ...stagingNow!.units, warrior: (stagingNow!.units.warrior ?? 0) + c2.need!.qty + 2, settler: 5 } }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, staging)));
      const p3 = await pass();
      const c3 = p3.campaigns.find((c) => c.targetRegionId === N)!;
      expect(c3.stage, c3.note).toBe("marching");
      const [force] = await db.select().from(armies).where(eq(armies.id, c3.armyId!));
      expect(force).toMatchObject({ mission: "conquer", targetRegionId: N, status: "outbound" });
      expect(force!.units.settler).toBe(5);

      // It arrives and takes the region; pass 4 closes the campaign.
      await skip(force!.arrivesAt.toISOString());
      const [won] = await db.select({ owner: matchRegions.ownerPlayerId }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, N)));
      expect(won?.owner).toBe(benPid);
      // The region is his now, so it is no longer a target: the row is cleared by the conquest itself, not by a later pass.
      const [adv] = await db.select({ settings: advisors.settings }).from(advisors).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid), eq(advisors.kind, "military")));
      expect(((adv!.settings ?? {}) as { targets?: string[] }).targets ?? []).toEqual([]);
      expect(matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).advisors.find((a) => a.kind === "military")?.settings.targets).toEqual([]);
      const p4 = await pass();
      expect(p4.campaigns.find((c) => c.targetRegionId === N)?.stage).toBe("done");
      expect((await Ben.call("POST", `${base}/advisors/military/fire`, {})).statusCode).toBe(200);
      // The scouting wrote into Ben's notes; the notes test that follows starts from none.
      await db.delete(regionNotes).where(and(eq(regionNotes.matchId, gameId), eq(regionNotes.playerId, benPid)));
    } finally {
      await redis.quit().catch(() => {});
    }
  });

  it("the Warden of the Thaw: hired for her wage, puts the regions in the ice's path on the clock, evacuates one to safe ground with a route, sends the capital wagon ahead of the ice, and starts a colony on the warm side", async () => {
    const base = `/api/matches/${gameId}`;
    // Nunavut freezes on day 2; Manitoba, one hop south, on day 13. Both are given to Ben, Nunavut as his capital, twelve hours before the ice reaches it.
    const A = "ca-nunavut";
    const S = "ca-manitoba";
    const benState = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    const benPid = benState.me.playerId;
    const oldCapital = benState.me.capitalRegionId;
    const [mrow] = await db.select({ startsAt: matches.startsAt, speed: matches.speed, clockOffsetSeconds: matches.clockOffsetSeconds }).from(matches).where(eq(matches.id, gameId));
    const freezeA = mrow!.startsAt!.getTime() + (2 * 86400_000) / mrow!.speed;
    const wantNow = freezeA - 12 * (3600_000 / mrow!.speed);
    const nowMs = Date.now() + mrow!.clockOffsetSeconds * 1000;
    if (wantNow > nowMs) await db.update(matches).set({ clockOffsetSeconds: sql`${matches.clockOffsetSeconds} + ${Math.ceil((wantNow - nowMs) / 1000)}` }).where(eq(matches.id, gameId));
    const now = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).match.now;
    // Ben's other regions are thinned so Manitoba is his most populous safe region, and a day's wage (a share of what all of them gather) stays within his stores.
    await db.update(matchRegions).set({ popWorkers: 120 }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid), sql`${matchRegions.popWorkers} > 120`));
    for (const [id, pop] of [[A, 40], [S, 200]] as const) {
      const row = { ownerPlayerId: benPid, popWorkers: pop, popSoldiers: 0, popOccupiers: 0, units: { warrior: 3 }, buildings: { storehouse: 6 }, food: 4000, wood: 4000, stone: 3500, special: { copper: 100, iron: 120 }, frozenAt: null, evacuatedAt: null, settledAt: new Date(now) };
      await db.insert(matchRegions).values({ matchId: gameId, regionId: id, assignment: { ...balance.start.assignment }, ...row }).onConflictDoUpdate({ target: [matchRegions.matchId, matchRegions.regionId], set: row });
    }
    await db.update(players).set({ capitalRegionId: A }).where(eq(players.id, benPid));
    await db.update(matchRegions).set({ isCapital: false }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid)));
    await db.update(matchRegions).set({ isCapital: true }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, A)));
    await fillEmpire(gameId, benPid, { food: 6000, wood: 16000, stone: 14000, copper: 100, iron: 120 });
    try {
      const regions = (await db.select({ n: sql<number>`count(*)::int` }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid), sql`${matchRegions.frozenAt} is null`)))[0]!.n;
      const hired = await Ben.call("POST", `${base}/advisors/thaw/hire`, {});
      expect(hired.statusCode, hired.body).toBe(200);
      expect((hired.json() as { wage: Record<string, number> }).wage.food).toBeGreaterThan(0);
      expect((await Ben.call("PUT", `${base}/advisors/thaw/settings`, { warningHours: 24, capitalHours: 48, destination: "safest", moveCapital: true, settle: true })).statusCode).toBe(200);
      // The first hour is charged by the tick before she works; here it is simply marked paid.
      await db.update(advisors).set({ paidUntil: sql`${advisors.hiredAt} + interval '1 minute'` }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid), eq(advisors.kind, "thaw")));
      const r = await forcePassAs(ben, "thaw", gameId);
      expect(r.statusCode, r.body).toBe(200);
      const report = (r.json() as { report: { evacuated: number; settled: number; trained: number; clock: Array<{ regionId: string; hoursLeft: number }>; suggestions: Array<{ text: string }> } }).report;
      // Nunavut is on the clock and has been emptied toward Manitoba; the capital wagon follows.
      expect(report.clock.map((l) => l.regionId)).toContain(A);
      expect(report.clock.find((l) => l.regionId === A)!.hoursLeft).toBeLessThanOrEqual(24);
      expect(report.evacuated, JSON.stringify(report.suggestions)).toBe(1);
      const [column] = await db.select().from(armies).where(and(eq(armies.matchId, gameId), eq(armies.playerId, benPid), eq(armies.mission, "move"), eq(armies.originRegionId, A), eq(armies.targetRegionId, S), eq(armies.status, "outbound")));
      expect(column).toBeDefined();
      expect(column!.units.warrior).toBe(3);
      const [after] = await db.select({ evacuatedAt: matchRegions.evacuatedAt }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, A)));
      expect(after!.evacuatedAt).not.toBeNull();
      const [wagon] = await db.select().from(armies).where(and(eq(armies.matchId, gameId), eq(armies.playerId, benPid), eq(armies.mission, "relocate"), eq(armies.status, "outbound")));
      expect(wagon, JSON.stringify(report.suggestions)).toBeDefined();
      expect(wagon!.targetRegionId).toBe(S);
      // The warm side: settlers ordered at Manitoba (or already on the road), unless every neighbour is taken, which the report says.
      const colony = report.settled > 0 || report.trained >= balance.settle.settlersRequired || report.suggestions.some((s) => /No free land/.test(s.text));
      expect(colony, JSON.stringify(report.suggestions)).toBe(true);
      // Manitoba, safe, is not on the clock and was not touched.
      expect(report.clock.map((l) => l.regionId)).not.toContain(S);
      expect((await Ben.call("POST", `${base}/advisors/thaw/fire`, {})).statusCode).toBe(200);
    } finally {
      await db.update(players).set({ capitalRegionId: oldCapital }).where(eq(players.id, benPid));
      await db.update(matchRegions).set({ isCapital: false }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, A)));
      if (oldCapital) await db.update(matchRegions).set({ isCapital: true }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, oldCapital)));
      await db.delete(armies).where(and(eq(armies.matchId, gameId), eq(armies.playerId, benPid), inArray(armies.originRegionId, [A, S])));
      await db.update(matchRegions).set({ ownerPlayerId: null, popWorkers: 0, units: {}, evacuatedAt: null }).where(and(eq(matchRegions.matchId, gameId), inArray(matchRegions.regionId, [A, S])));
    }
  });

  it("the Chancellor: hired for his wage, queues the research path to the next age, buys what a waiting order owes from the cheapest fair offer, and lists a store near its cap at the fair price", async () => {
    const base = `/api/matches/${gameId}`;
    const benState = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    const benPid = benState.me.playerId;
    const cap = benState.me.capitalRegionId!;
    const annState = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json());
    const annCap = annState.me.capitalRegionId!;
    const nowIso = async () => matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).match.now;
    await fillEmpire(gameId, benPid, { food: 12000, wood: 12000, stone: 9000, copper: 100, iron: 100 });
    // A training order at Ben's capital still owes stone, and Ann offers stone for wood a little under fair.
    const [job] = await db
      .insert(jobs)
      .values({ matchId: gameId, playerId: benPid, regionId: cap, kind: "train", refId: "warrior", qty: 10, slot: 9, payload: { cost: { stone: 500 }, paid: {} }, waitingFor: { stone: 500 }, startsAt: new Date(await nowIso()), endsAt: new Date(Date.parse(await nowIso()) + 3600_000) })
      .returning();
    await db.update(matchRegions).set({ stone: 2000, settledAt: new Date(await nowIso()) }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, annCap)));
    // Posted straight into the book (Ann's command allowance is spent by the fair-play test later); the goods were escrowed by hand above.
    const annPid = annState.me.playerId;
    const [annOrder] = await db.insert(marketOrders).values({ matchId: gameId, playerId: annPid, regionId: annCap, offerResource: "stone", offerAmount: 400, askResource: "wood", askAmount: 400, status: "open" }).returning();
    const annOrderId = annOrder!.id;
    try {
      const regions = (await db.select({ n: sql<number>`count(*)::int` }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.ownerPlayerId, benPid), sql`${matchRegions.frozenAt} is null`)))[0]!.n;
      const hired = await Ben.call("POST", `${base}/advisors/chancellor/hire`, {});
      expect(hired.statusCode, hired.body).toBe(200);
      expect((hired.json() as { wage: Record<string, number> }).wage.food).toBeGreaterThan(0);
      expect((await Ben.call("PUT", `${base}/advisors/chancellor/settings`, { researchGoal: "age", sell: true, buy: true, sellAbove: 0.8, overpay: 1.25, reserveShare: 0.3, maxOrders: 3 })).statusCode).toBe(200);
      await fillEmpire(gameId, benPid, { food: 12000, wood: 12000, stone: 9000, copper: 100, iron: 100 });
      await db.update(advisors).set({ paidUntil: sql`${advisors.hiredAt} + interval '1 minute'` }).where(and(eq(advisors.matchId, gameId), eq(advisors.playerId, benPid), eq(advisors.kind, "chancellor")));
      const r = await forcePassAs(ben, "chancellor", gameId);
      expect(r.statusCode, r.body).toBe(200);
      const report = (r.json() as { report: { researched: number; listed: number; bought: number; suggestions: Array<{ text: string }> } }).report;
      // Research: techs on the way to the next age are queued, prerequisites first.
      const research = await db.select({ refId: jobs.refId }).from(jobs).where(and(eq(jobs.matchId, gameId), eq(jobs.playerId, benPid), eq(jobs.kind, "research"), sql`${jobs.completedAt} is null`, sql`${jobs.cancelledAt} is null`));
      expect(report.researched, JSON.stringify(report.suggestions)).toBeGreaterThan(0);
      expect(research.length).toBeGreaterThanOrEqual(report.researched);
      // Buying: Ann's stone is taken for the waiting order, into the capital.
      const [filled] = await db.select().from(marketOrders).where(eq(marketOrders.id, annOrderId));
      expect(filled!.status, JSON.stringify(report.suggestions)).toBe("filled");
      expect(filled!.filledByPlayerId).toBe(benPid);
      expect(report.bought).toBe(1);
      // Selling: the capital's full wood store is listed at the fair price, asking for the stone still owed.
      const mine = await db.select().from(marketOrders).where(and(eq(marketOrders.matchId, gameId), eq(marketOrders.playerId, benPid), eq(marketOrders.status, "open")));
      expect(report.listed, JSON.stringify(report.suggestions)).toBeGreaterThan(0);
      const wood = mine.find((o) => o.offerResource === "wood");
      expect(wood).toBeDefined();
      expect(wood!.askAmount).toBe(fairAmount("wood", wood!.offerAmount, wood!.askResource));
      expect(mine.length).toBeLessThanOrEqual(3);
      expect((await Ben.call("POST", `${base}/advisors/chancellor/fire`, {})).statusCode).toBe(200);
    } finally {
      await db.delete(jobs).where(eq(jobs.id, job!.id));
      await db.update(marketOrders).set({ status: "cancelled" }).where(and(eq(marketOrders.matchId, gameId), eq(marketOrders.status, "open")));
    }
  });

  it("the books: every hire, build, order and research is on the ledger by day and category, and the tick samples what the empire gathers and eats", async () => {
    const base = `/api/matches/${gameId}`;
    const benState = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    const cap = benState.me.capitalRegionId!;
    // A build paid on the spot joins the ledger under buildings.
    await fillEmpire(gameId, benState.me.playerId, { food: 4000, wood: 4000, stone: 3000, copper: 50, iron: 50 });
    const queued = await Ben.call("POST", `${base}/regions/${cap}/build`, { buildingId: "huts" });
    expect(queued.statusCode, queued.body).toBe(200);
    const redis = createRedis();
    try {
      await db.update(matches).set({ lastTickAt: new Date(Date.now() - 3600_000) }).where(eq(matches.id, gameId));
      await runMatchTicks(db, new Publisher(redis), logger);
      const r = await Ben.call("GET", `${base}/finance`);
      expect(r.statusCode, r.body).toBe(200);
      const f = r.json() as { day: number; now: { gross: Record<string, number>; eaten: { people: number; soldiers: number }; regions: number }; history: Array<{ day: number; gross: Record<string, number> }>; spending: Array<{ day: number; category: string; resource: string; amount: number }> };
      expect(f.now.gross.food).toBeGreaterThan(0);
      expect(f.now.eaten.people).toBeGreaterThan(0);
      expect(f.now.regions).toBeGreaterThan(0);
      expect(f.history.length).toBeGreaterThan(0);
      expect(f.history[f.history.length - 1]!.gross.food).toBeGreaterThan(0);
      const total = (cat: string) => f.spending.filter((s) => s.category === cat).reduce((a, s) => a + s.amount, 0);
      // The advisors hired earlier, the Chancellor's research and market listing, and the Huts just queued.
      expect(total("advisors")).toBeGreaterThan(0);
      expect(total("research")).toBeGreaterThan(0);
      expect(total("market")).toBeGreaterThan(0);
      expect(f.spending.some((s) => s.category === "build" && s.resource === "wood" && s.amount > 0)).toBe(true);
      expect((await Out.call("GET", `${base}/finance`)).statusCode).toBe(403);
    } finally {
      await redis.quit().catch(() => {});
    }
  });

  it("a battle plays out: decided on arrival, then a unit or two a round under a crossed-swords icon everyone can watch, and nothing changes hands until the last round", async () => {
    const base = `/api/matches/${gameId}`;
    const benState = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    const cap = benState.me.capitalRegionId!;
    const benPid = benState.me.playerId;
    const nowIso = async () => matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).match.now;
    // A small neutral tribe within a few hops of Ben's capital, and eight warriors at home to raid it with.
    const claimed = new Set((await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), sql`${matchRegions.ownerPlayerId} is not null`))).map((r) => r.regionId));
    let ring = [cap];
    const seen = new Set(ring);
    let N: string | undefined;
    for (let hop = 0; hop < 4 && !N; hop++) {
      const next: string[] = [];
      for (const id of ring) for (const nb of regionById(id)?.neighbors ?? []) if (!seen.has(nb)) { seen.add(nb); next.push(nb); }
      N = next.find((id) => !claimed.has(id));
      ring = next;
    }
    expect(N).toBeTruthy();
    const T = N!;
    const tribe = { ownerPlayerId: null, popWorkers: 20, popSoldiers: 0, popOccupiers: 0, units: { warrior: 3 }, food: 900, wood: 400, stone: 300, settledAt: new Date(await nowIso()) };
    await db.insert(matchRegions).values({ matchId: gameId, regionId: T, assignment: { ...balance.start.assignment }, ...tribe }).onConflictDoUpdate({ target: [matchRegions.matchId, matchRegions.regionId], set: tribe });
    const [capRow] = await db.select({ units: matchRegions.units }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
    await db.update(matchRegions).set({ units: { ...capRow!.units, warrior: (capRow!.units.warrior ?? 0) + 8 }, popWorkers: 80, settledAt: new Date(await nowIso()) }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
    const redis = createRedis();
    const pub = new Publisher(redis);
    const wasRoundMs = process.env.BATTLE_ROUND_MS;
    process.env.BATTLE_ROUND_MS = "1";
    try {
      const sent = await Ben.call("POST", `${base}/regions/${cap}/send`, { mission: "raid", targetRegionId: T, units: { warrior: 8 }, people: 0, cargo: {} });
      expect(sent.statusCode, sent.body).toBe(200);
      const armyId = (sent.json() as { armyId: string }).armyId;
      const [army0] = await db.select().from(armies).where(eq(armies.id, armyId));
      // Arrival: the result is decided and the playback begins; the army stands on the region, fighting.
      const secs = Math.ceil((army0!.arrivesAt.getTime() - Date.parse(await nowIso())) / 1000) + 2;
      if (secs > 0) await db.update(matches).set({ clockOffsetSeconds: sql`${matches.clockOffsetSeconds} + ${secs}` }).where(eq(matches.id, gameId));
      await runDueJobs(db, pub, logger);
      const [army1] = await db.select().from(armies).where(eq(armies.id, armyId));
      expect(army1!.status).toBe("fighting");
      const list = await Ben.call("GET", `${base}/battles`);
      expect(list.statusCode, list.body).toBe(200);
      const live = (list.json() as Array<{ id: string; regionId: string; status: string; totalRounds: number }>).find((b) => b.regionId === T)!;
      expect(live).toBeDefined();
      expect(live.status).toBe("fighting");
      const st1 = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
      expect(st1.battles.some((b) => b.id === live.id)).toBe(true);
      expect(st1.armies.find((a) => a.id === armyId)?.status).toBe("fighting");
      const detail0 = await Ben.call("GET", `${base}/battles/${live.id}`);
      expect(detail0.statusCode, detail0.body).toBe(200);
      const d0 = detail0.json() as { attacker: { start: Record<string, number>; now: Record<string, number> }; defender: { start: Record<string, number>; now: Record<string, number> }; totalRounds: number; result: unknown };
      expect(d0.attacker.start.warrior).toBe(8);
      expect(d0.defender.start.warrior).toBe(3);
      expect(d0.defender.start.militia).toBe(1);
      expect(d0.result).toBeNull();
      // Everyone in the match may watch, and a stranger may not.
      expect((await Ann.call("GET", `${base}/battles/${live.id}`)).statusCode).toBe(200);
      expect((await Out.call("GET", `${base}/battles/${live.id}`)).statusCode).toBe(403);
      // The rounds: a unit or two fall each time, the region itself untouched until the end.
      const [before] = await db.select({ units: matchRegions.units }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, T)));
      let done = false;
      let lastStanding = 8 + 4;
      for (let i = 0; i < 400 && !done; i++) {
        await new Promise((r) => setTimeout(r, 3));
        await runDueJobs(db, pub, logger);
        const [b] = await db.select().from(battles).where(eq(battles.id, live.id));
        const l = b!.live as { attacker: { now: Record<string, number> }; defender: { now: Record<string, number> }; log: Array<{ round: number }> };
        const standing = Object.values(l.attacker.now).reduce((a, n) => a + n, 0) + Object.values(l.defender.now).reduce((a, n) => a + n, 0);
        expect(lastStanding - standing).toBeLessThanOrEqual(2);
        expect(lastStanding - standing).toBeGreaterThanOrEqual(0);
        lastStanding = standing;
        if (b!.status === "fighting" && b!.round > 0 && b!.round < b!.totalRounds) {
          const [mid] = await db.select({ units: matchRegions.units }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, T)));
          expect(mid!.units).toEqual(before!.units);
        }
        done = b!.status === "done";
      }
      expect(done).toBe(true);
      // The end: the stored result is applied exactly as a battle always was.
      const [b] = await db.select().from(battles).where(eq(battles.id, live.id));
      const report = b!.report as { attackerWon: boolean; attacker: { losses: Record<string, number> }; defender: { losses: Record<string, number> } };
      const lost = (u: Record<string, number>) => Object.values(u).reduce((a, n) => a + n, 0);
      expect(b!.totalRounds).toBe(lost(report.attacker.losses) + lost(report.defender.losses));
      expect(b!.round).toBe(b!.totalRounds);
      const [after] = await db.select({ units: matchRegions.units }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, T)));
      expect(after!.units.warrior ?? 0).toBe(3 - (report.defender.losses.warrior ?? 0));
      const [army2] = await db.select().from(armies).where(eq(armies.id, armyId));
      expect(["returning", "done"]).toContain(army2!.status);
      expect(lost(army2!.units)).toBe(8 - lost(report.attacker.losses));
      const detail1 = (await Ben.call("GET", `${base}/battles/${live.id}`)).json() as { status: string; result: { attackerWon: boolean } | null };
      expect(detail1.status).toBe("done");
      expect(detail1.result?.attackerWon).toBe(report.attackerWon);
      const told = await db.select().from(messages).where(and(eq(messages.matchId, gameId), eq(messages.playerId, benPid), eq(messages.kind, "battle"), sql`${messages.payload}->>'regionId' = ${T}`));
      expect(told.length).toBeGreaterThan(0);
      expect(matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).battles.some((x) => x.id === live.id)).toBe(false);
      // The battle is kept for the whole match: the report links to it, the full list carries it with its verdict, and a report
      // from before reports carried the id is matched to its battle by region and time when the inbox is read.
      const mine = told.find((x) => (x.payload as { battleId?: string }).battleId === live.id);
      expect(mine, "the report carries the battle id").toBeDefined();
      const history = (await Ben.call("GET", `${base}/battles?all=1`)).json() as Array<{ id: string; status: string; attackerWon: boolean | null; conquered: boolean }>;
      expect(history.find((x) => x.id === live.id)).toMatchObject({ status: "done", attackerWon: report.attackerWon });
      expect((await Ben.call("GET", `${base}/battles`)).json()).toEqual([]);
      await db.update(messages).set({ payload: { ...(mine!.payload as Record<string, unknown>), battleId: undefined } }).where(eq(messages.id, mine!.id));
      const inbox = (await Ben.call("GET", `${base}/messages`)).json() as { messages: Array<{ id: string; payload: { battleId?: string } }> };
      expect(inbox.messages.find((x) => x.id === mine!.id)?.payload.battleId).toBe(live.id);
    } finally {
      process.env.BATTLE_ROUND_MS = wasRoundMs ?? "0";
      await redis.quit().catch(() => {});
      await db.delete(regionNotes).where(and(eq(regionNotes.matchId, gameId), eq(regionNotes.regionId, T)));
    }
  });

  it("a convoy's walk home is priced like its way out: roads and travel techs count on every leg", async () => {
    const base = `/api/matches/${gameId}`;
    const benState = matchStateView.parse((await Ben.call("GET", `${base}/state`)).json());
    const cap = benState.me.capitalRegionId!;
    const benPid = benState.me.playerId;
    const nowIso = async () => matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).match.now;
    // A free neighbour becomes Ben's, with Roads at both ends and Harness known: the trip there is shorter than the bare map says.
    // The nearest unclaimed region within three hops (earlier tests took the capital's neighbours).
    const near: string[] = [];
    {
      const seen = new Set([cap]);
      let ring = [cap];
      for (let hop = 0; hop < 3; hop++) {
        const next: string[] = [];
        for (const id of ring) for (const n of regionById(id)?.neighbors ?? []) if (!seen.has(n)) { seen.add(n); next.push(n); near.push(n); }
        ring = next;
      }
    }
    const claimed = new Set((await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), inArray(matchRegions.regionId, near), sql`${matchRegions.ownerPlayerId} is not null`))).map((r) => r.regionId));
    const N = near.find((n) => !claimed.has(n))!;
    expect(N).toBeTruthy();
    const at = new Date(await nowIso());
    await db
      .insert(matchRegions)
      .values({ matchId: gameId, regionId: N, assignment: { ...balance.start.assignment }, settledAt: at, ownerPlayerId: benPid, popWorkers: 5, buildings: { roads: 1 } })
      .onConflictDoUpdate({ target: [matchRegions.matchId, matchRegions.regionId], set: { ownerPlayerId: benPid, popWorkers: 5, settledAt: at, buildings: { roads: 1 } } });
    const [capRow] = await db.select({ units: matchRegions.units, buildings: matchRegions.buildings }).from(matchRegions).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
    await db.update(matchRegions).set({ units: { ...capRow!.units, caravan: (capRow!.units.caravan ?? 0) + 1 }, buildings: { ...capRow!.buildings, roads: 1 }, food: 2000, settledAt: at }).where(and(eq(matchRegions.matchId, gameId), eq(matchRegions.regionId, cap)));
    await db.insert(playerTechs).values({ matchId: gameId, playerId: benPid, techId: "harness", completedAt: at }).onConflictDoNothing();
    const sent = await Ben.call("POST", `${base}/regions/${cap}/send`, { mission: "transport", targetRegionId: N, units: { caravan: 1 }, people: 0, cargo: { food: 50 } });
    expect(sent.statusCode, sent.body).toBe(200);
    const armyId = (sent.json() as { armyId: string }).armyId;
    const [out] = await db.select().from(armies).where(eq(armies.id, armyId));
    const outbound = out!.arrivesAt.getTime() - out!.departsAt.getTime();
    // Without roads or Harness the same caravan would take longer.
    const bare = travelSeconds(findRoute(cap, N, false)!, unitById.get("caravan")!.speed, benState.match.speed) * 1000;
    expect(outbound).toBeLessThan(bare);
    // It arrives and walks home: the return leg is priced the same way, so it takes as long as the way out, not the bare time.
    const redis = createRedis();
    const pub = new Publisher(redis);
    try {
      const secs = Math.ceil((out!.arrivesAt.getTime() - Date.parse(await nowIso())) / 1000) + 2;
      if (secs > 0) await db.update(matches).set({ clockOffsetSeconds: sql`${matches.clockOffsetSeconds} + ${secs}` }).where(eq(matches.id, gameId));
      await runDueJobs(db, pub, logger);
      // The return leg is its own mission job (the walk home may already be over on a short route).
      const [home] = await db.select().from(jobs).where(and(eq(jobs.refId, armyId), eq(jobs.kind, "mission"))).orderBy(desc(jobs.startsAt)).limit(1);
      expect(home).toBeDefined();
      expect(Math.abs(home!.startsAt.getTime() - out!.arrivesAt.getTime())).toBeLessThan(1000);
      const homeward = home!.endsAt.getTime() - home!.startsAt.getTime();
      // Legs are not symmetric (the terrain entered sets the cost), so the way home is checked against the same formula
      // run on the reverse route with Ben's roads and techs, and against the bare reverse time it used to take.
      const { legContextFor } = await import("../src/sim/legs.js");
      const ctx = await legContextFor(db, gameId, benPid);
      const expected = travelSeconds(findRoute(N, cap, false, ctx.roads, ctx.rails, ctx.harbors)!, unitById.get("caravan")!.speed * (1 + techEffectsOf(ctx.techs).travel), benState.match.speed) * 1000;
      const bareBack = travelSeconds(findRoute(N, cap, false)!, unitById.get("caravan")!.speed, benState.match.speed) * 1000;
      expect(Math.abs(homeward - expected)).toBeLessThan(1500);
      expect(homeward).toBeLessThan(bareBack);
    } finally {
      await redis.quit().catch(() => {});
      await db.delete(playerTechs).where(and(eq(playerTechs.playerId, benPid), eq(playerTechs.techId, "harness")));
    }
  });

  it("region notes: a player marks a region and writes a note only they can read", async () => {
    const base = `/api/matches/${gameId}`;
    const state = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json());
    const cap = state.me.capitalRegionId!;
    const annId = await idOf(ann.email);
    const actionsBefore = (await db.select().from(playerActions).where(eq(playerActions.userId, annId))).length;
    expect((await Ann.call("PUT", `${base}/notes/no-such-region`, { text: "x" })).statusCode).toBe(404);
    expect((await Out.call("PUT", `${base}/notes/${cap}`, { text: "x" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("PUT", `${base}/notes/${cap}`, { text: "x", colour: "pink" })).statusCode).toBe(400);
    const put = await Ann.call("PUT", `${base}/notes/${cap}`, { text: "  Ben scouted this on day 2  ", colour: "red" });
    expect(put.statusCode, JSON.stringify(put.json())).toBe(200);
    let notes = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json()).notes;
    expect(notes).toEqual([expect.objectContaining({ regionId: cap, text: "Ben scouted this on day 2", colour: "red" })]);
    // Ben sees nothing of it.
    expect(matchStateView.parse((await Ben.call("GET", `${base}/state`)).json()).notes).toEqual([]);
    // Saving again replaces, never duplicates; a marker alone is kept; empty text and no marker removes it.
    expect((await Ann.call("PUT", `${base}/notes/${cap}`, { text: "", colour: "blue" })).statusCode).toBe(200);
    notes = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json()).notes;
    expect(notes).toEqual([expect.objectContaining({ regionId: cap, text: "", colour: "blue" })]);
    expect((await Ann.call("PUT", `${base}/notes/${cap}`, { text: "", colour: null })).statusCode).toBe(200);
    expect(matchStateView.parse((await Ann.call("GET", `${base}/state`)).json()).notes).toEqual([]);
    // Notes are not game commands: they never count toward the per-minute cap.
    expect((await db.select().from(playerActions).where(eq(playerActions.userId, annId))).length).toBe(actionsBefore);
  });

  it("pause and resume are admin-only and freeze the match clock", async () => {
    const base = `/api/matches/${gameId}`;
    expect((await Ann.call("POST", `${base}/pause`, {})).statusCode).toBe(403);
    expect((await A.call("POST", `${base}/pause`, {})).statusCode).toBe(200);
    let state = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json());
    expect(state.match.pausedAt).not.toBeNull();
    expect((await Ann.call("POST", `${base}/regions/${state.me.capitalRegionId}/build`, { buildingId: "huts" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await Ann.call("POST", `${base}/resume`, {})).statusCode).toBe(403);
    expect((await A.call("POST", `${base}/resume`, {})).statusCode).toBe(200);
    state = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json());
    expect(state.match.pausedAt).toBeNull();
    expect((await Ann.call("POST", `${base}/regions/${state.me.capitalRegionId}/build`, { buildingId: "huts" })).statusCode).toBe(200);
  });

  it("time online is active time: an open tab stops counting five minutes after the last touch", async () => {
    const { openClock, touch, drain, IDLE_MS } = await import("../src/stats/activeClock.js");
    const min = 60_000;
    const c = openClock(0);
    // Touches every half minute for ten minutes: all ten count.
    for (let t = 30_000; t <= 10 * min; t += 30_000) touch(c, t);
    expect(drain(c, 10 * min).seconds).toBe(600);
    // Then nothing for an hour: only the idle allowance after the last touch counts, and the gap never does.
    expect(drain(c, 70 * min).seconds).toBe(IDLE_MS / 1000);
    touch(c, 70 * min);
    expect(drain(c, 70 * min).seconds).toBe(0);
    // Back for two minutes, then the tab closes: the two minutes count, with the whole session's active time alongside.
    touch(c, 72 * min);
    const last = drain(c, 72 * min);
    expect(last.seconds).toBe(120);
    expect(last.sessionSeconds).toBe(600 + IDLE_MS / 1000 + 120);
  });

  it("player statistics: logins and live sessions are counted per account, and only admins see the figures", async () => {
    const annId = await idOf(ann.email);
    const { recordLogin, recordSessionStart, recordOnline } = await import("../src/stats/userStats.js");
    await recordLogin(db, annId, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
    await recordSessionStart(db, annId, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", new Date("2026-10-18T19:30:00Z"));
    await recordOnline(db, annId, 900, 900);
    await recordOnline(db, annId, 300, 1200);
    expect((await Ann.call("GET", "/api/admin/player-stats")).statusCode).toBeGreaterThanOrEqual(400);
    const res = await A.call("GET", "/api/admin/player-stats");
    expect(res.statusCode, res.body).toBe(200);
    const mine = (res.json() as { players: Array<{ id: string; hoursOnline: number; sessions: number; logins: number; topDevice: string | null; longestSessionMinutes: number; activeHoursUtc: Array<{ hour: number; n: number }>; played: number; commands: number }> }).players.find((p) => p.id === annId)!;
    expect(mine).toBeTruthy();
    expect(mine.logins).toBeGreaterThanOrEqual(1);
    expect(mine.sessions).toBeGreaterThanOrEqual(1);
    expect(mine.hoursOnline).toBeCloseTo(0.3, 1);
    expect(mine.longestSessionMinutes).toBe(20);
    expect(mine.topDevice).toBe("Safari · iOS · phone");
    expect(mine.activeHoursUtc[0]?.hour).toBe(19);
    expect(mine.played).toBeGreaterThanOrEqual(0);
    // The hall of fame carries wins, losses, ties and points for its champions.
    const hof = (await Out.call("GET", "/api/public/hall-of-fame")).json() as { champions: Array<{ wins: number; losses: number; ties: number; score: number }> };
    for (const c of hof.champions) expect(c.wins + c.losses + c.ties).toBeGreaterThan(0);
  });

  it("admin oversight: matches, fair play and kicking a player", async () => {
    const list = await A.call("GET", "/api/admin/matches");
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain(gameId);
    // Live metrics: who is here, the account funnel, every open match with its worker health.
    expect((await Ann.call("GET", "/api/admin/metrics")).statusCode).toBe(404);
    const metrics = await A.call("GET", "/api/admin/metrics");
    expect(metrics.statusCode).toBe(200);
    const mt = metrics.json() as { online: { users: unknown[]; sockets: number }; active15m: { id: string }[]; users: { total: number; approved: number }; matches: { open: Array<{ id: string; status: string; humans: number; ai: number; jobs: { open: number } }> }; activity: { battles24h: number } };
    expect(mt.users.total).toBeGreaterThanOrEqual(4);
    expect(mt.users.approved).toBeGreaterThanOrEqual(2);
    const adminId = await idOf(admin.email);
    expect(mt.active15m.some((u) => u.id === adminId)).toBe(true);
    const row = mt.matches.open.find((m) => m.id === gameId);
    expect(row).toMatchObject({ status: "running", humans: 2, ai: 0 });
    expect(row!.jobs.open).toBeGreaterThanOrEqual(0);
    expect(typeof mt.online.sockets).toBe("number");
    const procs = (metrics.json() as { processes: { workerBeatSeconds: number | null; aiBeatSeconds: number | null; lobbiesOverdue: number } }).processes;
    expect(procs.lobbiesOverdue).toBeGreaterThanOrEqual(0);
    expect(procs.workerBeatSeconds === null || typeof procs.workerBeatSeconds === "number").toBe(true);
    const fp = await A.call("GET", "/api/admin/fairplay");
    expect(fp.statusCode, fp.body).toBe(200);
    const scan = await A.call("POST", "/api/admin/fairplay/scan", {});
    expect(scan.statusCode, scan.body).toBe(200);
    expect((await A.call("POST", "/api/admin/fairplay/00000000-0000-0000-0000-000000000000/review", { verdict: "cleared" })).statusCode).toBe(404);
    expect((await A.call("POST", "/api/admin/fairplay/00000000-0000-0000-0000-000000000000/review", { verdict: "guilty" })).statusCode).toBe(400);
    const benId = await idOf(ben.email);
    expect((await Ann.call("POST", `/api/admin/matches/${gameId}/kick/${benId}`, {})).statusCode).toBe(404);
    expect((await A.call("POST", `/api/admin/matches/${gameId}/kick/${benId}`, {})).statusCode).toBe(200);
    expect((await A.call("POST", `/api/admin/matches/${gameId}/kick/${benId}`, {})).statusCode).toBe(404);
    const [p] = await db.select().from(players).where(and(eq(players.matchId, gameId), eq(players.userId, benId)));
    expect(p?.eliminatedAt).not.toBeNull();
    const state = matchStateView.parse((await Ben.call("GET", `/api/matches/${gameId}/state`)).json());
    expect(state.owned).toEqual([]);
  });

  it("tournaments take registrations, open to joining an hour before, and remind a day and an hour ahead", async () => {
    const startsAt = new Date(Date.now() + 3 * 86400_000);
    const t = await A.call("POST", "/api/matches", { name: `Cup ${suffix}`, speed: 1, startsInMinutes: 0, startsAt: startsAt.toISOString(), kind: "tournament" });
    expect(t.statusCode, JSON.stringify(t.json())).toBe(201);
    const cupId = (t.json() as { id: string }).id;
    created.push(cupId);
    // Not open yet: joining is refused, registering works once, the listing shows it.
    expect((await Ann.call("POST", `/api/matches/${cupId}/join`, {})).statusCode).toBe(409);
    expect((await Out.call("POST", `/api/matches/${cupId}/register`, {})).statusCode).toBe(403);
    expect((await Ann.call("POST", `/api/matches/${cupId}/register`, {})).statusCode).toBe(201);
    expect((await Ann.call("POST", `/api/matches/${cupId}/register`, {})).statusCode).toBe(200);
    expect((await Ann.call("POST", `/api/matches/${gameId}/register`, {})).statusCode).toBe(400);
    const row = ((await Ann.call("GET", "/api/matches")).json() as Array<{ id: string; registered: boolean; registrations: number; joinOpensAt: string | null }>).find((m) => m.id === cupId)!;
    expect(row).toMatchObject({ registered: true, registrations: 1 });
    expect(Date.parse(row.joinOpensAt!)).toBe(startsAt.getTime() - balance.schedule.joinOpensHours * 3600_000);
    const asBen = ((await Ben.call("GET", "/api/matches")).json() as Array<{ id: string; registered: boolean }>).find((m) => m.id === cupId)!;
    expect(asBen.registered).toBe(false);
    // Reminders: nothing three days out; the day-ahead mail inside a day; the lobby-open mail inside an hour; each once.
    expect(await sendTournamentReminders(db, logger)).toBe(0);
    await db.update(matches).set({ startsAt: new Date(Date.now() + 20 * 3600_000) }).where(eq(matches.id, cupId));
    expect(await sendTournamentReminders(db, logger)).toBe(1);
    expect(await sendTournamentReminders(db, logger)).toBe(0);
    let [reg] = await db.select().from(tournamentRegistrations).where(eq(tournamentRegistrations.matchId, cupId));
    expect(reg?.remindedDayAt).not.toBeNull();
    expect(reg?.remindedHourAt).toBeNull();
    await db.update(matches).set({ startsAt: new Date(Date.now() + 30 * 60_000) }).where(eq(matches.id, cupId));
    expect(await sendTournamentReminders(db, logger)).toBe(1);
    expect(await sendTournamentReminders(db, logger)).toBe(0);
    [reg] = await db.select().from(tournamentRegistrations).where(eq(tournamentRegistrations.matchId, cupId));
    expect(reg?.remindedHourAt).not.toBeNull();
    // The lobby is open now: joining works, withdrawing a registration works too.
    expect((await Ann.call("POST", `/api/matches/${cupId}/join`, {})).statusCode).toBe(201);
    expect((await Ann.call("DELETE", `/api/matches/${cupId}/register`)).statusCode).toBe(200);
    // Registered but never in the lobby: enrolled at the start with a starting region picked for them. Withdrawn: not in.
    expect((await Ben.call("POST", `/api/matches/${cupId}/register`, {})).statusCode).toBe(201);
    expect((await A.call("POST", `/api/matches/${cupId}/dev/start`, {})).statusCode).toBe(200);
    const benId2 = await idOf(ben.email);
    const annId2 = await idOf(ann.email);
    const [benPlayer] = await db.select().from(players).where(and(eq(players.matchId, cupId), eq(players.userId, benId2)));
    expect(benPlayer?.capitalRegionId).toBeTruthy();
    expect(await db.select().from(players).where(and(eq(players.matchId, cupId), eq(players.userId, annId2)))).toHaveLength(1);
    // A registered player left out of a start that already happened comes in during the first days, with a capital of their own.
    await db.delete(players).where(and(eq(players.matchId, cupId), eq(players.userId, benId2)));
    const late = await Ben.call("POST", `/api/matches/${cupId}/join`, {});
    expect(late.statusCode, JSON.stringify(late.json())).toBe(201);
    const [benAgain] = await db.select().from(players).where(and(eq(players.matchId, cupId), eq(players.userId, benId2)));
    expect(benAgain?.capitalRegionId).toBeTruthy();
    expect(benAgain?.protectionUntil && benAgain.protectionUntil.getTime()).toBeGreaterThan(Date.now());
    // Not registered: still refused once it runs.
    expect((await Out.call("POST", `/api/matches/${cupId}/join`, {})).statusCode).toBeGreaterThanOrEqual(400);
    expect(((await Ann.call("GET", "/api/matches")).json() as Array<{ id: string; registered: boolean }>).find((m) => m.id === cupId)!.registered).toBe(false);
  });

  it("the creator of a game can start it at once or call it off; tournaments and other people's games are refused", async () => {
    // Ben has no game open; Ann's private game is still running, so Ben is the creator here.
    const secondRes = await Ben.call("POST", "/api/matches", { name: `Second ${suffix}`, speed: 10, startsInMinutes: 60, kind: "public" });
    expect(secondRes.statusCode, JSON.stringify(secondRes.json())).toBe(201);
    created.push((secondRes.json() as { id: string }).id);
    const second = ((await Ben.call("GET", "/api/matches")).json() as Array<{ id: string; name: string; createdByMe: boolean; status: string }>).find((m) => m.name === `Second ${suffix}`)!;
    expect(second).toMatchObject({ createdByMe: true, status: "lobby" });
    expect((await Ann.call("POST", `/api/matches/${second.id}/start-now`, {})).statusCode).toBe(403);
    expect((await Ann.call("DELETE", `/api/matches/${second.id}`)).statusCode).toBe(403);
    expect((await Ben.call("DELETE", `/api/matches/${second.id}`)).statusCode).toBe(200);
    expect(((await Ben.call("GET", "/api/matches")).json() as Array<{ id: string }>).some((m) => m.id === second.id)).toBe(false);
    const third = await Ben.call("POST", "/api/matches", { name: `Third ${suffix}`, speed: 10, startsInMinutes: 60, kind: "public", aiFillTo: 3 });
    expect(third.statusCode, JSON.stringify(third.json())).toBe(201);
    const thirdId = (third.json() as { id: string }).id;
    created.push(thirdId);
    expect((await Ben.call("POST", `/api/matches/${thirdId}/join`, {})).statusCode).toBe(201);
    expect((await Ben.call("POST", `/api/matches/${thirdId}/start-now`, {})).statusCode).toBe(200);
    const st = matchStateView.parse((await Ben.call("GET", `/api/matches/${thirdId}/state`)).json());
    expect(st.match.status).toBe("running");
    expect(st.match).toMatchObject({ createdByMe: true, tournament: false });
    expect(st.players.length).toBe(3);
    expect((await Ben.call("POST", `/api/matches/${thirdId}/start-now`, {})).statusCode).toBe(409);
    expect((await Ben.call("DELETE", `/api/matches/${thirdId}`)).statusCode).toBe(409);
    // Running and his: Ben ends it so he is free again, and the report records the early end.
    expect((await Ben.call("POST", `/api/matches/${thirdId}/end`, {})).statusCode).toBe(200);
    const cup = ((await A.call("GET", "/api/matches")).json() as Array<{ id: string; name: string }>).find((m) => m.name === `Cup ${suffix}`);
    if (cup) expect((await A.call("POST", `/api/matches/${cup.id}/start-now`, {})).statusCode).toBe(400);
  });

  it("the nightly simulation is created as an ordinary public game with a war-or-winter name", async () => {
    const sim = await createSimMatch(db);
    created.push(sim.id);
    expect(sim.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    const row = ((await Ann.call("GET", "/api/matches")).json() as Array<{ id: string; kind: string; speed: number; inviteCode: string | null; maxPlayers: number }>).find((m) => m.id === sim.id);
    expect(row).toMatchObject({ kind: "public", speed: SIM_SPEED, inviteCode: null });
    const [m] = await db.select().from(matches).where(eq(matches.id, sim.id));
    expect(m?.status).toBe("lobby");
    expect(m?.startsAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((m?.settings as { aiFillTo?: number }).aiFillTo).toBe(balance.match.maxAiTribes);
    // Nothing on its public face says it is a simulation.
    expect(JSON.stringify(row)).not.toContain("simulation");
  });

  it("an invited account sets its password from the mailed link, is verified and approved, and picks its tribe name once", async () => {
    const email = `inv-${suffix}@example.test`;
    const inv = await inviteUser(db, email.toUpperCase(), `Guest${suffix}`);
    expect(inv.created).toBe(true);
    const again = await inviteUser(db, email, `Guest${suffix}`);
    expect(again.created).toBe(false);
    expect(again.id).toBe(inv.id);
    const mail = inviteMail(`Guest${suffix}`, inv.token, 7, { name: "Frozen Watch", code: "ABCD1234" });
    expect(mail.text).toContain(`/reset?token=${encodeURIComponent(inv.token)}`);
    expect(mail.text).toContain("ABCD1234");
    expect(mail.text).toContain("Frozen Watch");
    expect(mail.text).toContain("pick your tribe name");
    const G = new Client(app);
    expect((await G.call("POST", "/api/auth/login", { email, password: "anything" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/reset", payload: { token: inv.token, password: "a password of my own" } })).statusCode).toBe(200);
    expect((await G.call("POST", "/api/auth/login", { email, password: "a password of my own" })).statusCode).toBe(200);
    expect((await G.call("GET", "/api/auth/me")).json()).toMatchObject({ emailVerified: true, approved: true, canRename: true, displayName: `Guest${suffix}` });
    expect((await G.call("PATCH", "/api/me/profile", { displayName: ann.displayName })).statusCode).toBe(409);
    expect((await G.call("PATCH", "/api/me/profile", { displayName: "x" })).statusCode).toBe(400);
    const renamed = await G.call("PATCH", "/api/me/profile", { displayName: `Icefang ${suffix}` });
    expect(renamed.statusCode, JSON.stringify(renamed.json())).toBe(200);
    expect((await G.call("GET", "/api/auth/me")).json()).toMatchObject({ displayName: `Icefang ${suffix}`, canRename: false });
    expect((await G.call("PATCH", "/api/me/profile", { displayName: `Another ${suffix}` })).statusCode).toBe(409);
    expect((await G.call("PATCH", "/api/me/profile", { tagline: "still allowed" })).statusCode).toBe(200);
    await db.delete(users).where(eq(users.email, email));
  });

  it("commands are logged, capped per minute, and a machine's rhythm raises an automation flag", async () => {
    const base = `/api/matches/${gameId}`;
    const annId = await idOf(ann.email);
    const state = matchStateView.parse((await Ann.call("GET", `${base}/state`)).json());
    const cap = state.me.capitalRegionId!;
    // Every command lands in the log with its route.
    const before = (await db.select().from(playerActions).where(eq(playerActions.userId, annId))).length;
    expect((await Ann.call("POST", `${base}/regions/${cap}/assign`, { food: 0.4, wood: 0.3, stone: 0.3 })).statusCode).toBe(200);
    expect((await Ann.call("GET", `${base}/state`)).statusCode).toBe(200);
    const logged = await db.select().from(playerActions).where(eq(playerActions.userId, annId)).orderBy(asc(playerActions.at));
    expect(logged.length).toBe(before + 1);
    expect(logged[logged.length - 1]!.kind).toMatch(/^regions\/[a-z0-9-]+\/assign$/);
    // The cap: more commands in a minute than a hand makes are refused.
    let refused = 0;
    for (let i = 0; i < balance.fairplay.commandsPerMinute + 5; i++) {
      const r = await Ann.call("POST", `${base}/regions/${cap}/assign`, { food: 0.4, wood: 0.3, stone: 0.3 });
      if (r.statusCode === 429) refused += 1;
    }
    expect(refused).toBeGreaterThanOrEqual(1);
    // The burst above also counts toward the per-address limit every test shares; clear it so the rest of the file is not throttled.
    const redis = createRedis();
    const rl = await redis.keys("lt-rl:*");
    if (rl.length) await redis.del(...rl);
    await redis.quit().catch(() => {});
    expect((await Ann.call("GET", `${base}/state`)).statusCode).toBe(200);
    // The scan: eighty commands exactly a minute apart across twenty-two hours is a loop, not a person.
    await db.delete(playerActions).where(eq(playerActions.userId, annId));
    const start = Date.now() - 23 * 3600_000;
    await db.insert(playerActions).values(Array.from({ length: 80 }, (_, i) => ({ matchId: gameId, userId: annId, at: new Date(start + i * 16.5 * 60_000), kind: "regions/x/assign" })));
    expect(await detectAutomation(db)).toBeGreaterThanOrEqual(1);
    const flagsRes = await A.call("GET", "/api/admin/fairplay");
    expect(flagsRes.statusCode, flagsRes.body).toBe(200);
    const flags = flagsRes.json() as { flags: Array<{ reason: string; userA: { id: string }; userB: { id: string }; evidence: { why?: string[] } }> };
    const mine = flags.flags.find((f) => f.reason.startsWith("automation") && f.userA.id === annId);
    expect(mine).toBeTruthy();
    expect(mine!.userB.id).toBe(annId);
    expect(mine!.evidence.why?.length).toBeGreaterThanOrEqual(2);
    // Scanning again does not flag the same day twice; a bursty human is never flagged.
    expect(await detectAutomation(db)).toBe(0);
    await db.delete(playerActions).where(eq(playerActions.userId, annId));
    const bursty = Array.from({ length: 80 }, (_, i) => new Date(start + 9 * 3600_000 + Math.floor(i / 20) * 3 * 3600_000 + (i % 20) * (5_000 + ((i * 7919) % 90_000))));
    await db.insert(playerActions).values(bursty.map((at) => ({ matchId: gameId, userId: annId, at, kind: "regions/x/build" })));
    await db.delete(fairplayFlags).where(eq(fairplayFlags.userA, annId));
    expect(await detectAutomation(db)).toBe(0);
  });

  it("a private game is never public: not in the sitemap, the public lists or the hall of fame; its pages are noindex; and its report, standings and replay are for its players and admins only", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "lt-web-"));
    writeFileSync(join(dir, "index.html"), '<!doctype html><html><head><meta name="description" content="generic" /><title>Last Thaw</title></head><body></body></html>');
    const before = process.env.WEB_DIST;
    process.env.WEB_DIST = dir;
    const slug = `2026-10-secret-${Date.now().toString(36)}`;
    const [priv] = await db
      .insert(matches)
      .values({ name: "Secret Thaw", slug, speed: 1, seed: "secret", startsAt: new Date(Date.now() - 40 * 86400_000), endsAt: new Date(Date.now() - 10 * 86400_000), finishedAt: new Date(Date.now() - 10 * 86400_000), status: "finished", settings: { kind: "private", createdBy: "nobody" } })
      .returning({ id: matches.id });
    try {
      const sitemap = await app.inject({ method: "GET", url: "/sitemap.xml" });
      expect(sitemap.body).not.toContain(slug);
      expect(JSON.stringify((await app.inject({ method: "GET", url: "/api/public/hall-of-fame" })).json())).not.toContain(priv!.id);
      expect(JSON.stringify((await app.inject({ method: "GET", url: "/api/public/matches" })).json())).not.toContain(priv!.id);
      const page = await Out.call("GET", `/match/${slug}/report`);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("noindex");
      // Nobody outside: not anonymous, not a logged-in stranger; an admin may look.
      expect((await Out.call("GET", `/api/matches/${priv!.id}/summary`)).statusCode).toBe(403);
      expect((await Ben.call("GET", `/api/matches/${priv!.id}/summary`)).statusCode).toBe(403);
      expect((await Ben.call("GET", `/api/matches/${priv!.id}/replay`)).statusCode).toBe(403);
      expect((await Ben.call("GET", `/api/matches/${priv!.id}/leaderboard`)).statusCode).toBe(403);
      expect((await A.call("GET", `/api/matches/${priv!.id}/replay`)).statusCode).toBe(200);
    } finally {
      await db.delete(matches).where(eq(matches.id, priv!.id));
      if (before === undefined) delete process.env.WEB_DIST;
      else process.env.WEB_DIST = before;
    }
  });

  it("match pages are served with their own head: title, description, sharing card and structured data", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "lt-web-"));
    writeFileSync(join(dir, "index.html"), '<!doctype html><html><head><meta name="description" content="generic" /><meta property="og:title" content="g" /><meta property="og:description" content="g" /><title>Last Thaw</title></head><body></body></html>');
    const before = process.env.WEB_DIST;
    process.env.WEB_DIST = dir;
    try {
      const page = await Out.call("GET", `/match/${gameId}/report`);
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain("<title>");
      expect(page.body).toContain('rel="canonical"');
      // A match still running is kept out of the index; a finished one carries its structured data.
      expect(page.body).toContain("noindex");
      expect((await Out.call("GET", "/match/no-such-thing/report")).statusCode).toBe(200);
    } finally {
      if (before === undefined) delete process.env.WEB_DIST;
      else process.env.WEB_DIST = before;
    }
  });

  it("public pages and histories answer without a session", async () => {
    for (const url of ["/api/public/matches", "/api/public/hall-of-fame", "/api/matches/past"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
    const sitemap = await app.inject({ method: "GET", url: "/sitemap.xml" });
    expect(sitemap.statusCode).toBe(200);
    expect(sitemap.headers["content-type"]).toContain("application/xml");
    expect(sitemap.body).toContain("<urlset");
    expect(sitemap.body).toContain("/how-to-play</loc>");
    expect((await app.inject({ method: "GET", url: "/api/me/history" })).statusCode).toBe(401);
    const h = await Ann.call("GET", "/api/me/history");
    expect(h.statusCode).toBe(200);
    expect(h.json()).toMatchObject({ played: 0, titles: [] });
    expect((h.json() as { active: { matchId: string }[] }).active.some((a) => a.matchId === gameId)).toBe(true);
  });

  it("the hall of fame, the standings and the report agree on the winner's regions: frozen ones count for nobody", async () => {
    const [done] = await db
      .insert(matches)
      .values({ name: "Frozen Count", slug: `2026-10-frozen-count-${Date.now().toString(36)}`, speed: 1, seed: "frozen-count", startsAt: new Date(Date.now() - 40 * 86400_000), endsAt: new Date(Date.now() - 10 * 86400_000), finishedAt: new Date(Date.now() - 10 * 86400_000), status: "finished", settings: { kind: "public", createdBy: "nobody" } })
      .returning({ id: matches.id });
    try {
      const [w] = await db.insert(players).values({ matchId: done!.id, name: "Holdfast", isAi: true, age: 4, score: 900 }).returning({ id: players.id });
      await db.update(matches).set({ winnerPlayerId: w!.id, winKind: "survival" }).where(eq(matches.id, done!.id));
      const [a, b, c] = allRegions();
      const row = { matchId: done!.id, ownerPlayerId: w!.id, assignment: { food: 1, wood: 0, stone: 0 }, settledAt: new Date() };
      await db.insert(matchRegions).values([
        { ...row, regionId: a!.id },
        { ...row, regionId: b!.id },
        { ...row, regionId: c!.id, frozenAt: new Date(Date.now() - 12 * 86400_000) },
      ]);
      const hof = (await app.inject({ method: "GET", url: "/api/public/hall-of-fame" })).json() as { matches: Array<{ id: string; winner: { regions: number } | null }> };
      expect(hof.matches.find((m) => m.id === done!.id)?.winner?.regions).toBe(2);
      const board = (await Ann.call("GET", `/api/matches/${done!.id}/leaderboard`)).json() as { players: Array<{ id: string; regions: number }> };
      expect(board.players.find((s) => s.id === w!.id)?.regions).toBe(2);
      const summary = (await Out.call("GET", `/api/matches/${done!.id}/summary`)).json() as { standings: Array<{ id: string; regions: number }> };
      expect(summary.standings.find((s) => s.id === w!.id)?.regions).toBe(2);
    } finally {
      await db.delete(matches).where(eq(matches.id, done!.id));
    }
  });

});
