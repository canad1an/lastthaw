import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { balance, buildingById,
  buildingCost, iceLatitudeOnDay, matchStateView, regionById } from "@lastthaw/shared";
import { buildApp } from "../src/api/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { battles, jobs, matchRegions, matches, players, transfers, users } from "../src/db/schema.js";
import { runAiDecisions, runMatchTicks } from "../src/sim/tick.js";
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
  async call(method: "GET" | "POST" | "DELETE", url: string, body?: Record<string, unknown>) {
    const res = await this.app.inject({
      method,
      url,
      ...(body ? { payload: body } : {}),
      headers: { cookie: this.cookie, ...(body ? { "content-type": "application/json" } : {}) },
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
    // A second tech queues behind the first; a third whose prerequisite is only queued is allowed too.
    expect((await a.call("POST", `/api/matches/${matchId}/research`, { techId: "flint_tools" })).statusCode).toBe(200);
    expect((await a.call("POST", `/api/matches/${matchId}/research`, { techId: "fire_making" })).statusCode).toBe(409);
    const queuedResearch = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json()).jobs.filter((j) => j.kind === "research");
    expect(queuedResearch).toHaveLength(2);
    expect(queuedResearch[1]!.startsAt).toBe(queuedResearch[0]!.endsAt);
    expect((await a.call("POST", `/api/matches/${matchId}/jobs/${queuedResearch[1]!.id}/cancel`, {})).statusCode).toBe(200);
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
    const leftover = await db.select({ kind: jobs.kind, refId: jobs.refId, attempts: jobs.attempts, lastError: jobs.lastError, endsAt: jobs.endsAt, waitingFor: jobs.waitingFor }).from(jobs).where(and(eq(jobs.matchId, matchId), isNull(jobs.completedAt)));
    expect(state.jobs, JSON.stringify({ leftover, now: state.match.now })).toHaveLength(0);
    expect(state.owned[0]!.buildings.huts).toBe(1);
    expect(state.owned[0]!.units.warrior).toBe(3);
    expect(state.owned[0]!.popSoldiers).toBeCloseTo(3, 5);
    expect(state.me.techs).toContain("fire_making");
    expect(state.owned[0]!.capacity).toBe(balance.economy.baseCapacity + (buildingById.get("huts")!.effect.capacity ?? 0));
    const inbox = (await a.call("GET", `/api/matches/${matchId}/messages`)).json() as { unread: number; messages: { subject: string }[] };
    expect(inbox.unread).toBeGreaterThanOrEqual(3); // plus any ice notices from the skipped days
    expect(inbox.messages.map((m) => m.subject)).toEqual(expect.arrayContaining(["Huts level 1 finished", "3 Warrior trained", "Fire making researched"]));

    // Cancelling a not-yet-started job refunds in full.
    const woodBefore = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json()).owned[0]!.wood;
    const b2 = (await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/build`, { buildingId: "huts" })).json() as { jobId: string };
    const b3 = (await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/build`, { buildingId: "storehouse" })).json() as { jobId: string };
    expect((await a.call("POST", `/api/matches/${matchId}/jobs/${b3.jobId}/cancel`, {})).statusCode).toBe(200);
    const after = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    const woodAfter = after.owned[0]!.wood;
    const dayNow = ((Date.parse(after.match.now) - Date.parse(after.match.startsAt)) / 86400_000) * after.match.speed;
    const hutsWood = buildingCost(buildingById.get("huts")!, 2, dayNow).wood ?? 0;
    expect(woodAfter).toBeGreaterThan(woodBefore - hutsWood - 10); // only huts lvl 2 still paid, give or take production
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
    // Pick a neighbour nobody lives in, so the three warriors always win.
    const occupiedRows = await db.select({ regionId: matchRegions.regionId, pop: matchRegions.popWorkers, soldiers: matchRegions.popSoldiers }).from(matchRegions).where(eq(matchRegions.matchId, matchId));
    const occupied = new Set(occupiedRows.filter((r) => r.pop + r.soldiers >= 1).map((r) => r.regionId));
    const neighbour = regionById(aPick)!.neighbors.find((n) => !occupied.has(n)) ?? regionById(aPick)!.neighbors[0]!;
    // Conquest needs settlers along as occupiers, not people.
    expect((await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/send`, { mission: "conquer", targetRegionId: neighbour, units: { warrior: 3 }, people: 5, cargo: {} })).statusCode).toBe(400);
    const occupierJob = await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/train`, { unitId: "settler", qty: 5 });
    expect(occupierJob.statusCode, JSON.stringify(occupierJob.json())).toBe(200);
    await skipTo((occupierJob.json() as { endsAt: string }).endsAt);
    const conquerRes = await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/send`, { mission: "conquer", targetRegionId: neighbour, units: { warrior: 3, settler: 5 }, people: 0, cargo: {} });
    expect(conquerRes.statusCode, JSON.stringify(conquerRes.json())).toBe(200);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.armies).toHaveLength(1);
    expect(state.owned[0]!.units.warrior ?? 0).toBe(0);
    await skipTo(state.armies[0]!.arrivesAt);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    const fights = await db.select().from(battles).where(eq(battles.matchId, matchId));
    expect(state.owned.map((o) => o.regionId).sort(), JSON.stringify({ armies: state.armies, battles: fights.map((b) => b.report), inbox: (await a.call("GET", `/api/matches/${matchId}/messages`)).json() })).toEqual([aPick, neighbour].sort());
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

    // Recall: an outbound army can be turned around and comes home with everything it carried.
    {
      const warriorsBefore = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json()).owned.find((o) => o.regionId === neighbour)!.units.warrior ?? 0;
      const out = await a.call("POST", `/api/matches/${matchId}/regions/${neighbour}/send`, { mission: "scout", targetRegionId: aPick, units: { warrior: 1 }, people: 0, cargo: {} });
      expect(out.statusCode, JSON.stringify(out.json())).toBe(200);
      const { armyId } = out.json() as { armyId: string };
      const recalled = await a.call("POST", `/api/matches/${matchId}/armies/${armyId}/recall`, {});
      expect(recalled.statusCode, JSON.stringify(recalled.json())).toBe(200);
      expect((await a.call("POST", `/api/matches/${matchId}/armies/${armyId}/recall`, {})).statusCode).toBe(409);
      state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
      const army = state.armies.find((x) => x.id === armyId)!;
      expect(army.status).toBe("returning");
      await skipTo(army.returnsAt!);
      state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
      expect(state.armies.find((x) => x.id === armyId)).toBeUndefined();
      expect(state.owned.find((o) => o.regionId === neighbour)!.units.warrior).toBe(warriorsBefore);
    }

    // Settling: five settlers claim an empty frontier region and become its workers.
    expect((await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/train`, { unitId: "settler", qty: 3 })).statusCode).toBe(400);
    const settlerJob = await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/train`, { unitId: "settler", qty: 5 });
    expect(settlerJob.statusCode, JSON.stringify(settlerJob.json())).toBe(200);
    await skipTo((settlerJob.json() as { endsAt: string }).endsAt);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.owned.find((o) => o.regionId === aPick)!.units.settler).toBe(5);
    expect(state.frontier.length).toBeGreaterThan(0);
    const homestead = state.frontier[0]!;
    expect((await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/send`, { mission: "raid", targetRegionId: homestead, units: { settler: 5 }, people: 0, cargo: {} })).statusCode).toBe(400);
    const settleRes = await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/send`, { mission: "settle", targetRegionId: homestead, units: { settler: 5 }, people: 0, cargo: {} });
    expect(settleRes.statusCode, JSON.stringify(settleRes.json())).toBe(200);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    await skipTo(state.armies[0]!.arrivesAt);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    const settled = state.owned.find((o) => o.regionId === homestead);
    const homeRow = await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, homestead)));
    const meRow = await db.select({ id: players.id, capital: players.capitalRegionId, eliminatedAt: players.eliminatedAt }).from(players).where(eq(players.matchId, matchId));
    expect(settled, JSON.stringify({ homestead, homeRow, meRow, armies: state.armies, owned: state.owned.map((o) => o.regionId), inbox: ((await a.call("GET", `/api/matches/${matchId}/messages`)).json() as { messages: { subject: string }[] }).messages.slice(0, 6).map((x) => x.subject) })).toBeTruthy();
    expect(settled!.popWorkers).toBeGreaterThanOrEqual(4.9);
    expect(settled!.loyalty).toBeCloseTo(balance.settle.startingLoyalty, 5);

    // Caravans and trade routes: goods need carrying capacity; a route dispatches caravans that deliver and return.
    expect((await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/send`, { mission: "transport", targetRegionId: homestead, units: {}, people: 0, cargo: { food: 100 } })).statusCode).toBe(400);
    const caravanJob = await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/train`, { unitId: "caravan", qty: 2 });
    expect(caravanJob.statusCode, JSON.stringify(caravanJob.json())).toBe(200);
    await skipTo((caravanJob.json() as { endsAt: string }).endsAt);
    expect((await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/send`, { mission: "transport", targetRegionId: homestead, units: { caravan: 1 }, people: 0, cargo: { food: 900 } })).statusCode).toBe(400);
    expect((await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/send`, { mission: "raid", targetRegionId: homestead, units: { caravan: 1 }, people: 0, cargo: {} })).statusCode).toBe(400);
    const tradeRouteRes = await a.call("POST", `/api/matches/${matchId}/regions/${aPick}/routes`, { toRegionId: homestead, mode: "fixed", load: { food: 300 }, share: 0, caravans: 2, everyHours: 1 });
    expect(tradeRouteRes.statusCode, JSON.stringify(tradeRouteRes.json())).toBe(201);
    const routeId = (tradeRouteRes.json() as { id: string }).id;
    const foodBefore = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json()).owned.find((o) => o.regionId === homestead)!.food;
    const ran = await a.call("POST", `/api/matches/${matchId}/routes/${routeId}/run`, {});
    expect(ran.statusCode).toBe(200);
    expect((ran.json() as { result: string }).result).toMatch(/^sent 1 caravan with 300 food/);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.routes).toHaveLength(1);
    const convoy = state.armies.find((x) => x.mission === "transport")!;
    expect(convoy.units.caravan).toBe(1);
    // A convoy heading for the colony must not occupy its build queue.
    {
      const b = await a.call("POST", `/api/matches/${matchId}/regions/${homestead}/build`, { buildingId: "huts" });
      expect((b.json() as { error?: string }).error ?? "").not.toMatch(/queue is full/);
    }
    await skipTo(convoy.arrivesAt);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.owned.find((o) => o.regionId === homestead)!.food).toBeGreaterThan(foodBefore + 250);
    const back = state.armies.find((x) => x.id === convoy.id);
    expect(back?.status).toBe("returning");
    await skipTo(back!.returnsAt!);
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.owned.find((o) => o.regionId === aPick)!.units.caravan).toBe(2);
    expect((await a.call("POST", `/api/matches/${matchId}/routes/${routeId}/toggle`, {})).statusCode).toBe(200);
    expect((await a.call("DELETE", `/api/matches/${matchId}/routes/${routeId}`)).statusCode).toBe(200);

    // Evacuate: everyone and the stock they can carry leave the colony for the capital.
    {
      const before = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
      const colony = before.owned.find((o) => o.regionId === homestead)!;
      const ev = await a.call("POST", `/api/matches/${matchId}/regions/${homestead}/evacuate`, { toRegionId: aPick });
      expect(ev.statusCode, JSON.stringify(ev.json())).toBe(200);
      const body = ev.json() as { people: number; cargo: Record<string, number>; arrivesAt: string };
      expect(body.people).toBe(Math.floor(colony.popWorkers + colony.popOccupiers));
      expect(body.cargo.food ?? 0).toBeGreaterThan(0);
      let after = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
      expect(after.owned.find((o) => o.regionId === homestead)!.popWorkers).toBeLessThan(1);
      // Nobody is left right now (newcomers trickle back in over time, so check before skipping ahead).
      expect((await a.call("POST", `/api/matches/${matchId}/regions/${homestead}/evacuate`, { toRegionId: aPick })).statusCode).toBe(409);
      const capitalPeopleBefore = after.owned.find((o) => o.regionId === aPick)!.popWorkers;
      await skipTo(body.arrivesAt);
      after = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
      expect(after.owned.find((o) => o.regionId === aPick)!.popWorkers).toBeGreaterThan(capitalPeopleBefore + body.people - 1);
    }

    // Milestone 4: a match tick scores everyone and lets the AI tribe act.
    {
      const redis = createRedis();
      await runMatchTicks(db, new Publisher(redis), logger);
      await runAiDecisions(db, new Publisher(redis), logger);
      await redis.quit().catch(() => {});
    }
    state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.players.find((p) => p.id === state.me.playerId)!.score).toBeGreaterThan(0);
    const aiPlayer = state.players.find((p) => p.isAi)!;
    const aiJobs = await db.select().from(jobs).where(and(eq(jobs.playerId, aiPlayer.id), isNull(jobs.cancelledAt)));
    // The AI queues something unless its (randomly placed) capital has already frozen after the skipped days.
    const [aiCapital] = await db
      .select({ frozenAt: matchRegions.frozenAt })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.ownerPlayerId, aiPlayer.id)));
    if (!aiCapital?.frozenAt) expect(aiJobs.length).toBeGreaterThan(0);
    expect(state.owned.find((o) => o.regionId === neighbour)!.loyalty).toBeLessThan(1);

    // Skip past the end of the match; the worker finishes it.
    const seconds = Math.ceil((balance.match.lengthDays * 86400) / 10) + 60;
    expect((await a.call("POST", `/api/matches/${matchId}/dev/time-skip`, { seconds })).statusCode).toBe(200);
    const redis = createRedis();
    await runDueJobs(db, new Publisher(redis), logger);
    await redis.quit().catch(() => {});
    // A locally running dev worker may be racing us for the same jobs (SKIP LOCKED); allow it a moment.
    for (let i = 0; i < 20; i++) {
      state = matchStateView.parse((await a.call("GET", `/api/matches/${matchId}/state`)).json());
      if (state.match.status === "finished") break;
      await new Promise((r) => setTimeout(r, 250));
      await runJobs();
    }
    expect(state.match.status).toBe("finished");

    // Milestone 6: every ice step ran, high-latitude regions are frozen, leaderboard and history are filled in.
    const iceJobs = await db.select().from(jobs).where(and(eq(jobs.matchId, matchId), eq(jobs.kind, "ice_step")));
    expect(iceJobs).toHaveLength(balance.match.lengthDays);
    expect(iceJobs.filter((j) => !j.completedAt).map((j) => j.lastError)).toEqual([]);
    const finalLat = iceLatitudeOnDay(balance.match.lengthDays);
    const rows = await db.select().from(matchRegions).where(eq(matchRegions.matchId, matchId));
    for (const r of rows) {
      const lat = Math.abs(regionById(r.regionId)!.lat);
      if (lat >= finalLat) expect(r.frozenAt).not.toBeNull();
    }
    const board = (await a.call("GET", `/api/matches/${matchId}/leaderboard`)).json() as { match: { status: string; winnerPlayerId: string | null }; players: { rank: number; score: number }[] };
    expect(board.match.status).toBe("finished");
    expect(board.match.winnerPlayerId).toBeTruthy();
    expect(board.players[0]!.rank).toBe(1);
    expect(board.players[0]!.score).toBeGreaterThanOrEqual(board.players[1]!.score);
    const history = (await a.call("GET", "/api/me/history")).json() as { history: { matchId: string; rank: number }[]; played: number };
    expect(history.played).toBe(1);
    expect(history.history[0]!.matchId).toBe(matchId);
    expect(history.history[0]!.rank).toBeGreaterThanOrEqual(1);

    // Milestone 7: admin review is hidden from ordinary users.
    expect((await a.call("GET", "/api/admin/fairplay")).statusCode).toBe(404);
  });
});

describe("milestone 5 social", () => {
  let app: App;
  let db: Db;
  const suffix = `s${Date.now().toString(36)}`;
  const alice = { email: `alice-${suffix}@example.test`, password: "correct horse battery", displayName: `Alice${suffix}` };
  const bob = { email: `bob-${suffix}@example.test`, password: "correct horse battery", displayName: `Bob${suffix}` };
  const createdMatches: string[] = [];

  beforeAll(async () => {
    db = createDb();
    app = await buildApp({ db, realtime: false });
  });
  afterAll(async () => {
    for (const id of createdMatches) await db.delete(matches).where(eq(matches.id, id));
    for (const u of [alice, bob]) await db.delete(users).where(eq(users.email, u.email));
    await app.close();
    await db.close();
  });

  it("alliances, shared vision, chat and the market", async () => {
    const a = new Client(app);
    const b = new Client(app);
    expect((await a.call("POST", "/api/auth/register", alice)).statusCode).toBe(201);
    expect((await b.call("POST", "/api/auth/register", bob)).statusCode).toBe(201);
    for (const u of [alice, bob]) await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, u.email));

    const created = await a.call("POST", "/api/matches", { name: "social", speed: 10, startsInMinutes: 60, aiFillTo: 2, neutralTribes: 0 });
    expect(created.statusCode).toBe(201);
    const matchId = created.json().id as string;
    createdMatches.push(matchId);
    expect((await a.call("POST", `/api/matches/${matchId}/join`, {})).statusCode).toBe(201);
    expect((await b.call("POST", `/api/matches/${matchId}/join`, {})).statusCode).toBe(201);
    expect((await a.call("POST", `/api/matches/${matchId}/dev/start`, {})).json()).toMatchObject({ started: true });

    const stateOf = async (c: Client) => matchStateView.parse((await c.call("GET", `/api/matches/${matchId}/state`)).json());
    let aState = await stateOf(a);
    let bState = await stateOf(b);
    const aCapital = aState.me.capitalRegionId!;
    const bCapital = bState.me.capitalRegionId!;
    expect(aState.me.allianceId).toBeNull();
    expect(aState.allies).toEqual([]);

    // Alliance chat is refused before anyone is in an alliance.
    expect((await b.call("GET", `/api/matches/${matchId}/chat?channel=alliance`)).statusCode).toBe(403);
    expect((await b.call("POST", `/api/matches/${matchId}/chat`, { channel: "alliance", body: "hello?" })).statusCode).toBe(403);

    // Alice founds an alliance and invites Bob; Bob sees the invite and accepts.
    const made = await a.call("POST", `/api/matches/${matchId}/alliances`, { name: "Northern Pact", tag: "NP" });
    expect(made.statusCode, JSON.stringify(made.json())).toBe(201);
    const allianceId = made.json().id as string;
    expect((await a.call("POST", `/api/matches/${matchId}/alliances`, { name: "Again", tag: "AG" })).statusCode).toBe(409);
    expect((await b.call("POST", `/api/matches/${matchId}/alliances`, { name: "Clash", tag: "NP" })).statusCode).toBe(409);
    expect((await b.call("POST", `/api/matches/${matchId}/alliances/invite`, { playerId: aState.me.playerId })).statusCode).toBe(409);
    expect((await a.call("POST", `/api/matches/${matchId}/alliances/invite`, { playerId: bState.me.playerId })).statusCode).toBe(200);

    // Bob is still outside: alliance chat denied for a non-member.
    expect((await b.call("GET", `/api/matches/${matchId}/chat?channel=alliance`)).statusCode).toBe(403);

    const bList = (await b.call("GET", `/api/matches/${matchId}/alliances`)).json() as { mine: unknown; invites: { allianceId: string }[]; alliances: { tag: string }[] };
    expect(bList.mine).toBeNull();
    expect(bList.invites.map((i) => i.allianceId)).toEqual([allianceId]);
    expect(bList.alliances.map((x) => x.tag)).toEqual(["NP"]);
    const bInbox = (await b.call("GET", `/api/matches/${matchId}/messages`)).json() as { messages: { kind: string }[] };
    expect(bInbox.messages.some((m) => m.kind === "alliance")).toBe(true);

    expect((await b.call("POST", `/api/matches/${matchId}/alliances/accept`, { allianceId })).statusCode).toBe(200);
    const aList = (await a.call("GET", `/api/matches/${matchId}/alliances`)).json() as { mine: { members: { playerId: string; role: string; regions: number }[] }; myRole: string };
    expect(aList.myRole).toBe("leader");
    expect(aList.mine.members.map((m) => m.role).sort()).toEqual(["leader", "member"]);
    expect(aList.mine.members.every((m) => m.regions === 1)).toBe(true);

    // Both see the alliance on `me`; shared vision shows Bob's capital in Alice's sighted list.
    aState = await stateOf(a);
    bState = await stateOf(b);
    expect(aState.me.allianceId).toBe(allianceId);
    expect(aState.me.allianceTag).toBe("NP");
    expect(bState.me.allianceId).toBe(allianceId);
    expect(aState.allies).toEqual([bState.me.playerId]);
    const seenBob = aState.sighted.find((s) => s.regionId === bCapital);
    expect(seenBob).toBeDefined();
    expect(seenBob!.ownerPlayerId).toBe(bState.me.playerId);
    expect(seenBob!.ownerName).toBe(bob.displayName);
    expect(seenBob!.population).toBeGreaterThan(0);
    expect(bState.sighted.some((s) => s.regionId === aCapital && s.ownerPlayerId === aState.me.playerId)).toBe(true);

    // Chat: global post/list, alliance post/list, rate limit.
    const g = await a.call("POST", `/api/matches/${matchId}/chat`, { channel: "global", body: "hello world" });
    expect(g.statusCode, JSON.stringify(g.json())).toBe(201);
    expect((await a.call("POST", `/api/matches/${matchId}/chat`, { channel: "global", body: "too fast" })).statusCode).toBe(409);
    const gl = (await b.call("GET", `/api/matches/${matchId}/chat?channel=global`)).json() as { channel: string; messages: { playerName: string; body: string }[] };
    expect(gl.channel).toBe("global");
    expect(gl.messages).toHaveLength(1);
    expect(gl.messages[0]).toMatchObject({ playerName: alice.displayName, body: "hello world" });
    expect((await b.call("POST", `/api/matches/${matchId}/chat`, { channel: "alliance", body: "allies only" })).statusCode).toBe(201);
    const al = (await a.call("GET", `/api/matches/${matchId}/chat?channel=alliance`)).json() as { messages: { body: string }[] };
    expect(al.messages.map((m) => m.body)).toEqual(["allies only"]);
    expect(((await a.call("GET", `/api/matches/${matchId}/chat?channel=global`)).json() as { messages: unknown[] }).messages).toHaveLength(1);

    // Market: Alice posts 50 wood for 20 stone; the wood is escrowed immediately.
    const aBefore = (await stateOf(a)).owned.find((o) => o.regionId === aCapital)!;
    const posted = await a.call("POST", `/api/matches/${matchId}/market`, { regionId: aCapital, offerResource: "wood", offerAmount: 50, askResource: "stone", askAmount: 20 });
    expect(posted.statusCode, JSON.stringify(posted.json())).toBe(201);
    const orderId = posted.json().id as string;
    const aAfterPost = (await stateOf(a)).owned.find((o) => o.regionId === aCapital)!;
    expect(aAfterPost.wood).toBeLessThan(aBefore.wood - 45);
    expect((await a.call("POST", `/api/matches/${matchId}/market`, { regionId: aCapital, offerResource: "iron", offerAmount: 5, askResource: "stone", askAmount: 1 })).statusCode).toBe(409);
    expect((await b.call("POST", `/api/matches/${matchId}/market`, { regionId: aCapital, offerResource: "wood", offerAmount: 1, askResource: "stone", askAmount: 1 })).statusCode).toBe(403);
    expect((await a.call("POST", `/api/matches/${matchId}/market/${orderId}/accept`, { regionId: aCapital })).statusCode).toBe(400);

    const listing = (await b.call("GET", `/api/matches/${matchId}/market`)).json() as { open: { id: string; playerName: string; regionId: string }[]; mine: unknown[] };
    expect(listing.open.map((o) => o.id)).toEqual([orderId]);
    expect(listing.open[0]).toMatchObject({ playerName: alice.displayName, regionId: aCapital });
    expect(listing.mine).toHaveLength(0);

    // Bob accepts from his capital: he pays stone and gets wood; Alice gets stone.
    const bBefore = (await stateOf(b)).owned.find((o) => o.regionId === bCapital)!;
    expect(bBefore.stone).toBeGreaterThanOrEqual(20);
    const accepted = await b.call("POST", `/api/matches/${matchId}/market/${orderId}/accept`, { regionId: bCapital });
    expect(accepted.statusCode, JSON.stringify(accepted.json())).toBe(200);
    expect(accepted.json().received).toBe(50);
    const bAfter = (await stateOf(b)).owned.find((o) => o.regionId === bCapital)!;
    const aAfter = (await stateOf(a)).owned.find((o) => o.regionId === aCapital)!;
    expect(bAfter.stone).toBeLessThan(bBefore.stone - 15);
    expect(bAfter.wood).toBeGreaterThan(bBefore.wood + 45);
    expect(aAfter.stone).toBeGreaterThan(aAfterPost.stone + 15);
    expect(aAfter.wood).toBeLessThan(aBefore.wood - 45); // escrow is gone for good
    expect((await b.call("POST", `/api/matches/${matchId}/market/${orderId}/accept`, { regionId: bCapital })).statusCode).toBe(409);

    const rows = await db.select().from(transfers).where(eq(transfers.matchId, matchId));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.resource}:${r.amount}:${r.via}`).sort()).toEqual(["stone:20:trade", "wood:50:trade"]);
    const filled = (await a.call("GET", `/api/matches/${matchId}/market`)).json() as { open: unknown[]; mine: { id: string; status: string }[] };
    expect(filled.open).toHaveLength(0);
    expect(filled.mine).toEqual([expect.objectContaining({ id: orderId, status: "filled" })]);
    for (const c of [a, b]) {
      const inbox = (await c.call("GET", `/api/matches/${matchId}/messages`)).json() as { messages: { kind: string }[] };
      expect(inbox.messages.some((m) => m.kind === "trade")).toBe(true);
    }

    // Cancel refunds the escrow to the region.
    const beforeCancel = (await stateOf(a)).owned.find((o) => o.regionId === aCapital)!;
    const second = await a.call("POST", `/api/matches/${matchId}/market`, { regionId: aCapital, offerResource: "food", offerAmount: 30, askResource: "stone", askAmount: 5 });
    expect(second.statusCode).toBe(201);
    const secondId = second.json().id as string;
    expect((await b.call("POST", `/api/matches/${matchId}/market/${secondId}/cancel`, {})).statusCode).toBe(403);
    const cancelled = await a.call("POST", `/api/matches/${matchId}/market/${secondId}/cancel`, {});
    expect(cancelled.statusCode, JSON.stringify(cancelled.json())).toBe(200);
    expect(cancelled.json().refundedTo).toBe(aCapital);
    const afterCancel = (await stateOf(a)).owned.find((o) => o.regionId === aCapital)!;
    expect(afterCancel.food).toBeGreaterThan(beforeCancel.food - 5);
    expect((await a.call("POST", `/api/matches/${matchId}/market/${secondId}/cancel`, {})).statusCode).toBe(409);

    // Leaving: Alice (leader) leaves, Bob inherits; Bob leaves, the alliance dissolves.
    expect((await a.call("POST", `/api/matches/${matchId}/alliances/leave`, {})).json()).toMatchObject({ ok: true, dissolved: false });
    const bRole = (await b.call("GET", `/api/matches/${matchId}/alliances`)).json() as { myRole: string };
    expect(bRole.myRole).toBe("leader");
    expect((await stateOf(a)).allies).toEqual([]);
    expect((await b.call("POST", `/api/matches/${matchId}/alliances/leave`, {})).json()).toMatchObject({ ok: true, dissolved: true });
    expect(((await b.call("GET", `/api/matches/${matchId}/alliances`)).json() as { alliances: unknown[] }).alliances).toHaveLength(0);
  });
});
