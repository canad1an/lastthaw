import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { balance, matchStateView } from "@lastthaw/shared";
import { buildApp } from "../src/api/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { matches, users } from "../src/db/schema.js";
import { Publisher } from "../src/realtime/publish.js";
import { createRedis } from "../src/redis.js";
import { runDueJobs } from "../src/worker/jobs.js";
import { logger } from "../src/logger.js";

process.env.DATABASE_URL ??= "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DEV_TOOLS = "true";
process.env.SMTP_PORT ??= "1";

type App = Awaited<ReturnType<typeof buildApp>>;

/** A logged-in client bound to one cookie jar. */
class Client {
  cookie = "";
  constructor(private readonly app: App) {}
  async call(method: "GET" | "POST", url: string, body?: Record<string, unknown>) {
    const res = await this.app.inject({
      method,
      url,
      ...(body ? { payload: body } : {}),
      headers: { cookie: this.cookie, "content-type": "application/json" },
    });
    const set = res.headers["set-cookie"];
    const first = Array.isArray(set) ? set[0] : set;
    if (first) this.cookie = first.split(";")[0]!;
    return res;
  }
}

describe("milestone 1 flow", () => {
  let app: App;
  let db: Db;
  const suffix = Date.now().toString(36);
  const alice = { email: `alice-${suffix}@example.test`, password: "correct horse battery", displayName: `Alice${suffix}` };
  const bob = { email: `bob-${suffix}@example.test`, password: "correct horse battery", displayName: `Bob${suffix}` };

  const createdMatches: string[] = [];

  beforeAll(async () => {
    db = createDb();
    app = await buildApp({ db, realtime: false });
  });
  afterAll(async () => {
    // Leave the shared dev database as we found it.
    for (const id of createdMatches) await db.delete(matches).where(eq(matches.id, id));
    for (const u of [alice, bob]) await db.delete(users).where(eq(users.email, u.email));
    await app.close();
    await db.close();
  });

  it("runs register -> verify -> create -> join -> pick -> start -> grow -> assign", async () => {
    const a = new Client(app);
    const b = new Client(app);

    // Register both; unverified accounts cannot join.
    expect((await a.call("POST", "/api/auth/register", alice)).statusCode).toBe(201);
    expect((await b.call("POST", "/api/auth/register", bob)).statusCode).toBe(201);
    expect((await a.call("POST", "/api/auth/register", alice)).statusCode).toBe(409);

    const me = await a.call("GET", "/api/auth/me");
    expect(me.json()).toMatchObject({ displayName: alice.displayName, emailVerified: false });

    // Verify directly in the database (the mail path is covered by the token endpoints).
    for (const u of [alice, bob]) await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, u.email));

    // Create a 10x match starting far in the future, then start it by hand.
    const created = await a.call("POST", "/api/matches", { name: "test", speed: 10, startsInMinutes: 60 });
    expect(created.statusCode).toBe(201);
    const matchId = created.json().id as string;
    createdMatches.push(matchId);

    expect((await a.call("POST", `/api/matches/${matchId}/join`, {})).statusCode).toBe(201);
    expect((await b.call("POST", `/api/matches/${matchId}/join`, {})).statusCode).toBe(201);

    // Alice picks a start; Bob's options must be far from it.
    const aOpts = (await a.call("GET", `/api/matches/${matchId}/start-options`)).json() as { options: string[] };
    expect(aOpts.options.length).toBeGreaterThan(0);
    const aPick = aOpts.options[0]!;
    expect((await a.call("POST", `/api/matches/${matchId}/pick-start`, { regionId: aPick })).statusCode).toBe(200);
    const bOpts = (await b.call("GET", `/api/matches/${matchId}/start-options`)).json() as { options: string[] };
    expect(bOpts.options).not.toContain(aPick);
    expect((await b.call("POST", `/api/matches/${matchId}/pick-start`, { regionId: aPick })).statusCode).toBe(400);

    // Lobby state carries no owned regions yet.
    let state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.match.status).toBe("lobby");
    expect(state.owned).toHaveLength(0);

    // Start: both get a capital (Bob's auto-assigned) with the starting families.
    expect((await a.call("POST", `/api/matches/${matchId}/dev/start`, {})).json()).toMatchObject({ started: true });
    expect((await a.call("POST", `/api/matches/${matchId}/dev/start`, {})).json()).toMatchObject({ started: false });

    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.match.status).toBe("running");
    expect(state.owned).toHaveLength(1);
    const capital = state.owned[0]!;
    expect(capital.regionId).toBe(aPick);
    expect(capital.isCapital).toBe(true);
    expect(Math.round(capital.popWorkers)).toBe(balance.start.families * balance.start.peoplePerFamily);
    expect(state.players).toHaveLength(2);
    expect(state.players.every((p) => p.regions === 1)).toBe(true);

    // Bob never sees Alice's economy.
    const bState = matchStateView.parse((await b.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(bState.owned).toHaveLength(1);
    expect(bState.owned[0]!.regionId).not.toBe(aPick);
    expect(JSON.stringify(bState)).not.toContain(aPick);

    // Skip a real day: population and food grow.
    expect((await a.call("POST", `/api/matches/${matchId}/dev/time-skip`, { seconds: 86400 })).statusCode).toBe(200);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    const grown = state.owned[0]!;
    expect(grown.popWorkers).toBeGreaterThan(capital.popWorkers);
    expect(grown.food).toBeGreaterThan(capital.food);
    expect(Date.parse(state.match.now) - Date.now()).toBeGreaterThan(86000 * 1000);

    // Reassign everyone to stone: food rate goes negative, stone rate up; settle persisted.
    const assign = await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/assign`, { food: 0, wood: 0, stone: 1 });
    expect(assign.statusCode).toBe(200);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.owned[0]!.assignment.stone).toBeCloseTo(1, 5);
    expect(state.owned[0]!.rates.food).toBeLessThan(0);
    expect(state.owned[0]!.rates.stone).toBeGreaterThan(0);
    expect(state.owned[0]!.popWorkers).toBeCloseTo(grown.popWorkers, 0);

    // Bob cannot touch Alice's region.
    expect((await b.call("POST", `/api/matches/${matchId}/regions/${aPick}/assign`, { food: 1, wood: 0, stone: 0 })).statusCode).toBe(403);

    // Skip past the end of the match; the worker finishes it.
    const seconds = Math.ceil((balance.match.lengthDays * 86400) / 10) + 60;
    expect((await a.call("POST", `/api/matches/${matchId}/dev/time-skip`, { seconds })).statusCode).toBe(200);
    const redis = createRedis();
    await runDueJobs(db, new Publisher(redis), logger);
    await redis.quit().catch(() => {});
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.match.status).toBe("finished");
  });
});
