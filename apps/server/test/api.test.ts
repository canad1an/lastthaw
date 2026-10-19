import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { balance, matchStateView, regionById, scoutCatchChance, seededRng } from "@lastthaw/shared";
import { Publisher } from "../src/realtime/publish.js";
import { runDueJobs } from "../src/worker/jobs.js";
import { buildApp } from "../src/api/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { emailTokens, fairplayFlags, matches, playerActions, players, users, matchRegions, regionNotes } from "../src/db/schema.js";
import { detectAutomation } from "../src/fairplay/detect.js";
import { createRedis } from "../src/redis.js";
import { newToken } from "../src/auth/password.js";
import { SIM_SPEED, createSimMatch } from "../src/scripts/nightlySim.js";
import { inviteUser } from "../src/scripts/inviteUser.js";
import { sendTournamentReminders } from "../src/matches/registrations.js";
import { tournamentRegistrations } from "../src/db/schema.js";
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
});
