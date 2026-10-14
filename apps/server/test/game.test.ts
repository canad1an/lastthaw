import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { balance, matchStateView, regionById } from "@lastthaw/shared";
import { buildApp } from "../src/api/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { jobs, matches, users } from "../src/db/schema.js";
import { runMatchTicks } from "../src/sim/tick.js";
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
    const created = await a.call("POST", "/api/matches", { name: "test", speed: 10, startsInMinutes: 60, aiFillTo: 3, neutralTribes: 0 });
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
    expect(state.players).toHaveLength(3); // Alice, Bob and one AI tribe
    expect(state.players.filter((p) => p.isAi)).toHaveLength(1);
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

    // Milestone 2: queue a building, a training batch and a research project; pay up front.
    await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/assign`, { food: 0.6, wood: 0.25, stone: 0.15 });
    const before = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json()).owned[0]!;
    const build = await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/build`, { buildingId: "huts" });
    expect(build.statusCode).toBe(200);
    const train = await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/train`, { unitId: "warrior", qty: 3 });
    expect(train.statusCode).toBe(200);
    const research = await a.call("POST", `/api/matches/${matchId}/research`, { techId: "fire_making" });
    expect(research.statusCode).toBe(200);
    expect((await a.call("POST", `/api/matches/${matchId}/research`, { techId: "flint_tools" })).statusCode).toBe(409);
    expect((await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/build`, { buildingId: "farm" })).statusCode).toBe(400);

    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.jobs.map((j) => j.kind).sort()).toEqual(["build", "research", "train"]);
    expect(state.owned[0]!.wood).toBeLessThan(before.wood);

    // Queue is sequential per region: the training batch starts when the huts finish.
    const buildJob = state.jobs.find((j) => j.kind === "build")!;
    const trainJob = state.jobs.find((j) => j.kind === "train")!;
    expect(trainJob.startsAt).toBe(buildJob.endsAt);

    // Skip an hour and let the worker complete everything.
    expect((await a.call("POST", `/api/matches/${matchId}/dev/time-skip`, { seconds: 3600 })).statusCode).toBe(200);
    {
      const redis = createRedis();
      await runDueJobs(db, new Publisher(redis), logger);
      await redis.quit().catch(() => {});
    }
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.jobs).toHaveLength(0);
    expect(state.owned[0]!.buildings.huts).toBe(1);
    expect(state.owned[0]!.units.warrior).toBe(3);
    expect(state.owned[0]!.popSoldiers).toBeCloseTo(3, 5);
    expect(state.me.techs).toContain("fire_making");
    expect(state.owned[0]!.capacity).toBe(balance.economy.baseCapacity + 15);
    const inbox = (await a.call("GET", `/api/matches/${matchId}/messages`)).json() as { unread: number; messages: { subject: string }[] };
    expect(inbox.unread).toBe(3);
    expect(inbox.messages.map((m) => m.subject)).toEqual(expect.arrayContaining(["Huts level 1 finished", "3 Warrior trained", "Fire making researched"]));

    // Cancelling a not-yet-started job refunds in full.
    const woodBefore = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json()).owned[0]!.wood;
    const b2 = (await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/build`, { buildingId: "huts" })).json() as { jobId: string };
    const b3 = (await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/build`, { buildingId: "storehouse" })).json() as { jobId: string };
    expect((await a.call("POST", `/api/matches/${matchId}/jobs/${b3.jobId}/cancel`, {})).statusCode).toBe(200);
    const woodAfter = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json()).owned[0]!.wood;
    expect(woodAfter).toBeGreaterThan(woodBefore - 70); // only huts lvl 2 (60 wood) still paid, give or take production
    void b2;

    // Milestone 3/4: Alice conquers an empty neighbouring region with her warriors and five settlers.
    const runJobs = async () => {
      const redis = createRedis();
      await runDueJobs(db, new Publisher(redis), logger);
      await redis.quit().catch(() => {});
    };
    const skipTo = async (iso: string) => {
      const cur = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json()).match.now;
      const secs = Math.ceil((Date.parse(iso) - Date.parse(cur)) / 1000) + 5;
      if (secs > 0) expect((await a.call("POST", `/api/matches/${matchId}/dev/time-skip`, { seconds: secs })).statusCode).toBe(200);
      await runJobs();
    };
    const neighbour = regionById(aPick)!.neighbors[0]!;
    const conquerRes = await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/send`, { mission: "conquer", targetRegionId: neighbour, units: { warrior: 3 }, people: 5, cargo: {} });
    expect(conquerRes.statusCode, JSON.stringify(conquerRes.json())).toBe(200);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.armies).toHaveLength(1);
    expect(state.owned[0]!.units.warrior ?? 0).toBe(0);
    await skipTo(state.armies[0]!.arrivesAt);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.owned.map((o) => o.regionId).sort()).toEqual([aPick, neighbour].sort());
    const taken = state.owned.find((o) => o.regionId === neighbour)!;
    expect(taken.popOccupiers).toBeCloseTo(5, 0);
    expect(taken.units.warrior).toBe(3);
    expect(state.armies).toHaveLength(0);
    const aliceInbox = (await a.call("GET", `/api/matches/${matchId}/messages`)).json() as { messages: { kind: string; payload: { report?: { attackerWon: boolean; conquered: boolean } } }[] };
    const battleMsg = aliceInbox.messages.find((x) => x.kind === "battle");
    expect(battleMsg?.payload.report).toMatchObject({ attackerWon: true, conquered: true });

    // Raid Bob if he is reachable by land from the new region; the warning must show on his side.
    const bobCapital = bState.owned[0]!.regionId;
    const routeRes = await a.call("GET", `/api/matches/${matchId}/route?from=${neighbour}&to=${bobCapital}&speed=5`);
    if (routeRes.statusCode === 200) {
      const sendRes = await a.call("POST", `/api/matches/${matchId}/regions/${neighbour}/send`, { mission: "raid", targetRegionId: bobCapital, units: { warrior: 3 }, people: 0, cargo: {} });
      expect(sendRes.statusCode, JSON.stringify(sendRes.json())).toBe(200);
      const bobView = matchStateView.parse((await b.call("GET", `/api/matches/${matchId}/state`)).json());
      expect(bobView.incoming).toHaveLength(1);
      expect(bobView.incoming[0]!.fromPlayerName).toBe(alice.displayName);
      state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
      await skipTo(state.armies[0]!.arrivesAt);
      const bobInbox = (await b.call("GET", `/api/matches/${matchId}/messages`)).json() as { messages: { kind: string }[] };
      expect(bobInbox.messages.some((x) => x.kind === "battle")).toBe(true);
      state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
      if (state.armies[0]) {
        expect(state.armies[0].status).toBe("returning");
        await skipTo(state.armies[0].returnsAt!);
        state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
        expect(state.armies).toHaveLength(0);
      }
    }

    // Milestone 4: a match tick scores everyone and lets the AI tribe act.
    {
      const redis = createRedis();
      await runMatchTicks(db, new Publisher(redis), logger);
      await redis.quit().catch(() => {});
    }
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.players.find((p) => p.id === state.me.playerId)!.score).toBeGreaterThan(0);
    const aiPlayer = state.players.find((p) => p.isAi)!;
    const aiJobs = await db.select().from(jobs).where(and(eq(jobs.playerId, aiPlayer.id), isNull(jobs.cancelledAt)));
    expect(aiJobs.length).toBeGreaterThan(0); // it queued something
    expect(state.owned.find((o) => o.regionId === neighbour)!.loyalty).toBeLessThan(1);

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
