import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { balance, matchStateView, regionById } from "@lastthaw/shared";
import { buildApp } from "../src/api/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { armies, bounties, dailyObjectives, jobs, matchMilestones, matchRegions, matches, mercenaryOffers, messages, pacts, players, refugeeOffers, transfers, users } from "../src/db/schema.js";
import { claimBounties, objectiveWinner, pickObjective, placeBounty, resolveObjective } from "../src/sim/objectives.js";
import { tributeDemand } from "../src/sim/ai.js";
import { settleFrozenCapitals } from "../src/sim/ice.js";
import { Publisher } from "../src/realtime/publish.js";
import { createRedis } from "../src/redis.js";
import { stormHits, mercenariesLeave } from "../src/sim/worldEvents.js";
import { proposePact, respondPact } from "../src/sim/diplomacy.js";
import { runDueJobs } from "../src/worker/jobs.js";
import { logger } from "../src/logger.js";
import { applyIceStep } from "../src/sim/ice.js";
import { foundCapital, projectRegion } from "../src/sim/regions.js";
import { matchNow } from "../src/sim/clock.js";

process.env.DATABASE_URL ??= "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DEV_TOOLS = "true";
process.env.SMTP_PORT ??= "1";

/** World events: blizzards, migrant columns, the hidden horde player and the public feed. */
describe("world events", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: Db;
  const suffix = Date.now().toString(36);
  const user = { email: `ev-${suffix}@example.test`, password: "correct horse battery", displayName: `Eve${suffix}` };
  let cookie = "";
  let matchId = "";
  const call = async (method: "GET" | "POST", url: string, body?: Record<string, unknown>) => {
    const res = await app.inject({ method, url, ...(body ? { payload: body } : {}), headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) } });
    const jar = new Map(cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0]!, c]));
    for (const c of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) jar.set(c.split(";")[0]!.split("=")[0]!, c.split(";")[0]!);
    cookie = [...jar.values()].join("; ");
    return res;
  };
  beforeAll(async () => {
    db = createDb();
    app = await buildApp({ db, realtime: false });
  });
  afterAll(async () => {
    if (matchId) await db.delete(matches).where(eq(matches.id, matchId));
    await db.delete(users).where(eq(users.email, user.email));
    await app.close();
    await db.close();
  });

  it("storms halve production, the ice sends migrant columns, the horde is hidden, and the feed reads it all", async () => {
    expect((await call("POST", "/api/auth/register", user)).statusCode).toBe(201);
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, user.email));
    const created = await call("POST", "/api/matches", { name: `Events ${suffix}`, speed: 10, startsInMinutes: 0, aiFillTo: 2 });
    expect(created.statusCode).toBe(201);
    matchId = (created.json() as { id: string }).id;
    expect((await call("POST", `/api/matches/${matchId}/join`, {})).statusCode).toBe(201);
    expect((await call("POST", `/api/matches/${matchId}/dev/start`, {})).statusCode).toBe(200);
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId));
    const [me] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, (await db.select({ id: users.id }).from(users).where(eq(users.email, user.email)))[0]!.id)));
    expect(me?.capitalRegionId).toBeTruthy();

    // The horde's player exists, is hidden, and never shows in the standings or the state.
    const [horde] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, true)));
    expect(horde?.name).toBe(balance.events.horde.name);
    const state = matchStateView.parse((await call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.players.some((p) => p.id === horde!.id)).toBe(false);
    const board = (await call("GET", `/api/matches/${matchId}/leaderboard`)).json() as { players: { id: string }[] };
    expect(board.players.some((p) => p.id === horde!.id)).toBe(false);

    // A blizzard over the capital: production halves while it blows.
    const capital = me!.capitalRegionId!;
    const redis = createRedis();
    const publisher = new Publisher(redis);
    const before = projectRegion((await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital))))[0]!, matchNow(m!), m!.speed);
    await db.transaction(async (tx) => {
      const [job] = await tx.insert(jobs).values({ matchId, kind: "storm", payload: { regions: [capital], centre: capital }, startsAt: matchNow(m!), endsAt: matchNow(m!) }).returning();
      await stormHits(tx, m!, job!, publisher, () => {});
    });
    const stormed = (await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital))))[0]!;
    expect(stormed.stormUntil).not.toBeNull();
    const during = projectRegion(stormed, matchNow(m!), m!.speed);
    expect(during.rates.gross.wood).toBeCloseTo(before.rates.gross.wood * balance.events.storm.production, 0);
    const stateStorm = matchStateView.parse((await call("GET", `/api/matches/${matchId}/state`)).json());
    expect(stateStorm.storms).toContain(capital);
    expect(stateStorm.owned.find((o) => o.regionId === capital)?.stormUntil).toBeTruthy();

    // Give the player a far-north region with people, then run the day-30 ice step: a migrant column reaches the capital if it is within reach.
    const cap = regionById(capital)!;
    let north: string | null = null;
    const ring1 = cap.neighbors;
    const ring2 = [...new Set(ring1.flatMap((n) => regionById(n)!.neighbors))].filter((n) => n !== capital && !ring1.includes(n));
    for (const id of [...ring1, ...ring2]) {
      const r = regionById(id)!;
      if (Math.abs(r.lat) > Math.abs(cap.lat)) {
        north = id;
        break;
      }
    }
    expect(north, "a neighbour further from the equator").toBeTruthy();
    await db.transaction(async (tx) => {
      await foundCapital(tx, matchId, me!.id, north!, matchNow(m!));
      await tx.update(matchRegions).set({ isCapital: false, popWorkers: 100 }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, north!)));
    });
    // Force the freeze: an ice step whose line sits below this region's latitude.
    const freezeDay = 1; // the line is at 70°: only the region we push to 89° freezes
    await db.transaction(async (tx) => {
      const [job] = await tx.insert(jobs).values({ matchId, kind: "ice_step", payload: { day: freezeDay }, startsAt: matchNow(m!), endsAt: matchNow(m!) }).returning();
      // Only regions at or beyond the final line freeze on day 30; push the test region there by pretending it is at 89°.
      const r = regionById(north!)!;
      const realLat = r.lat;
      (r as { lat: number }).lat = 89;
      try {
        await applyIceStep(tx, m!, job!, publisher, () => {});
      } finally {
        (r as { lat: number }).lat = realLat;
      }
    });
    const offers = await db.select().from(refugeeOffers).where(and(eq(refugeeOffers.matchId, matchId), eq(refugeeOffers.playerId, me!.id)));
    expect(offers.length).toBe(1);
    expect(offers[0]!.people).toBe(Math.floor(100 * balance.events.refugees.share));
    const target = offers[0]!.regionId;
    const targetBefore = (await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, target))))[0]!;
    // Not enough food: refused. Then with food: accepted, people arrive, food is paid.
    await db.update(matchRegions).set({ food: 0 }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, target)));
    expect((await call("POST", `/api/matches/${matchId}/refugees/${offers[0]!.id}`, { accept: true })).statusCode).toBe(409);
    await db.update(matchRegions).set({ food: 5000 }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, target)));
    const accepted = await call("POST", `/api/matches/${matchId}/refugees/${offers[0]!.id}`, { accept: true });
    expect(accepted.statusCode, JSON.stringify(accepted.json())).toBe(200);
    const targetAfter = (await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, target))))[0]!;
    expect(targetAfter.popWorkers).toBeGreaterThanOrEqual(targetBefore.popWorkers + offers[0]!.people - 1);
    expect(targetAfter.food).toBeLessThan(5000);
    expect((await call("POST", `/api/matches/${matchId}/refugees/${offers[0]!.id}`, { accept: true })).statusCode).toBe(404);

    // The feed lists what happened, newest first, in words.
    const feed = (await call("GET", `/api/matches/${matchId}/feed`)).json() as { items: { kind: string; text: string }[] };
    const kinds = feed.items.map((i) => i.kind);
    expect(kinds).toContain("storm.hit");
    expect(kinds).toContain("refugees.arrived");
    expect(kinds).toContain("match.started");
    expect(feed.items.find((i) => i.kind === "refugees.arrived")?.text).toMatch(/people fleeing/);
    expect(kinds.indexOf("storm.hit")).toBeLessThan(kinds.indexOf("match.started"));
    await redis.quit().catch(() => {});
  });

  it("pacts stop raids, tribute lands on the ledger, mercenaries come and go, expeditions return, the last stand waits for the ice", async () => {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId));
    const [meRow] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.isAi, false)));
    const [ai] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.isAi, true), eq(players.hidden, false)));
    expect(ai?.capitalRegionId).toBeTruthy();
    const me = meRow!;
    const capital = me.capitalRegionId!;

    // A pact, accepted by the AI, blocks a raid on its capital.
    const proposed = await call("POST", `/api/matches/${matchId}/pacts`, { otherPlayerId: ai!.id, kind: "nap" });
    expect(proposed.statusCode, JSON.stringify(proposed.json())).toBe(200);
    const pactId = (proposed.json() as { id: string }).id;
    await respondPact(db, m!, ai!, pactId, true);
    await db.update(matchRegions).set({ units: { warrior: 12 }, popSoldiers: 12, special: { iron: 1000, copper: 0, tin: 0, horses: 0 }, food: 5000 }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital)));
    // Put an AI-owned region right next door, so the only thing stopping the raid is the pact.
    const ownedNow = new Set((await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(eq(matchRegions.matchId, matchId))).map((r) => r.regionId));
    const nextDoor = regionById(capital)!.neighbors.find((n) => !ownedNow.has(n))!;
    expect(nextDoor).toBeTruthy();
    await db.transaction(async (tx) => {
      await foundCapital(tx, matchId, ai!.id, nextDoor, matchNow(m!));
      await tx.update(matchRegions).set({ isCapital: false }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, nextDoor)));
    });
    const raid = await call("POST", `/api/matches/${matchId}/regions/${capital}/send`, { mission: "raid", targetRegionId: nextDoor, units: { warrior: 3 }, people: 0, cargo: {} });
    expect(raid.statusCode).toBe(400);
    expect((raid.json() as { error: string }).error).toMatch(/pact/);
    // Giving notice keeps it in force for a day.
    expect((await call("POST", `/api/matches/${matchId}/pacts/${pactId}/end`, {})).statusCode).toBe(200);
    expect((await call("POST", `/api/matches/${matchId}/regions/${capital}/send`, { mission: "raid", targetRegionId: nextDoor, units: { warrior: 3 }, people: 0, cargo: {} })).statusCode).toBe(400);

    // Tribute: the AI demands wood; we pay from the capital and it is on the ledger.
    await db.update(matchRegions).set({ wood: 3000 }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital)));
    const demand = await proposePact(db, m!, ai!, me.id, "tribute", { resource: "wood", amount: 500 });
    expect((await call("POST", `/api/matches/${matchId}/pacts/${demand.id}/pay`, {})).statusCode).toBe(200);
    const paid = await db.select().from(transfers).where(and(eq(transfers.matchId, matchId), eq(transfers.via, "tribute")));
    expect(paid.length).toBe(1);
    expect(paid[0]!.amount).toBe(500);

    // A second demand can be rejected outright: the demander is told, gets cause for war, and a bounty goes up on our capital.
    await db.update(pacts).set({ createdAt: new Date(Date.now() - 7 * 86400_000) }).where(eq(pacts.id, demand.id));
    const demand2 = await proposePact(db, m!, ai!, me.id, "tribute", { resource: "wood", amount: 400 });
    const rejected = await call("POST", `/api/matches/${matchId}/pacts/${demand2.id}/respond`, { accept: false });
    expect(rejected.statusCode, JSON.stringify(rejected.json())).toBe(200);
    expect((rejected.json() as { status: string }).status).toBe("refused");
    const told = await db.select().from(messages).where(and(eq(messages.matchId, matchId), eq(messages.playerId, ai!.id)));
    expect(told.some((x) => /rejected your tribute demand/.test(x.subject))).toBe(true);
    const openBounties = await db.select().from(bounties).where(eq(bounties.matchId, matchId));
    expect(openBounties.some((x) => /refused tribute/.test(x.reason ?? ""))).toBe(true);
    expect((await call("POST", `/api/matches/${matchId}/pacts/${demand2.id}/respond`, { accept: true })).statusCode).toBe(404);
    // Clear the bounty so the objectives test below starts from a clean board.
    for (const x of openBounties) if (/refused tribute/.test(x.reason ?? "")) await db.delete(bounties).where(eq(bounties.id, x.id));

    // Mercenaries: hire a company with iron, then their contract runs out.
    const [offer] = await db.insert(mercenaryOffers).values({ matchId, company: "the Grey Wolves", unitId: "sellsword", qty: 15, iron: 180, expiresAt: new Date(Date.now() + 3600_000) }).returning();
    const hired = await call("POST", `/api/matches/${matchId}/mercenaries/${offer!.id}/hire`, {});
    expect(hired.statusCode, JSON.stringify(hired.json())).toBe(200);
    let cap = (await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital))))[0]!;
    expect(cap.units.sellsword).toBe(15);
    expect((cap.special as { iron: number }).iron).toBeCloseTo(820, 0);
    expect((await call("POST", `/api/matches/${matchId}/mercenaries/${offer!.id}/hire`, {})).statusCode).toBe(404);
    const [leaveJob] = await db.select().from(jobs).where(and(eq(jobs.matchId, matchId), eq(jobs.kind, "merc_expire")));
    expect(leaveJob).toBeTruthy();
    await db.transaction((tx) => mercenariesLeave(tx, m!, { ...leaveJob!, endsAt: matchNow(m!) }));
    cap = (await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital))))[0]!;
    expect(cap.units.sellsword ?? 0).toBe(0);

    // An expedition needs the unknown, far away, and comes home with something.
    const capR = regionById(capital)!;
    const seen = new Set([capital]);
    let ring = [capital];
    let far: string | null = null;
    for (let h = 0; h < 4; h++) {
      const next: string[] = [];
      for (const id of ring) for (const n of regionById(id)!.neighbors) if (!seen.has(n)) { seen.add(n); next.push(n); }
      if (h >= 2 && next.length) far = next[0]!;
      ring = next;
    }
    expect(far).toBeTruthy();
    expect((await call("POST", `/api/matches/${matchId}/regions/${capital}/send`, { mission: "expedition", targetRegionId: capR.neighbors[0]!, units: { warrior: 3 }, people: 0, cargo: {} })).statusCode).toBe(400);
    const exp = await call("POST", `/api/matches/${matchId}/regions/${capital}/send`, { mission: "expedition", targetRegionId: far!, units: { warrior: 3 }, people: 0, cargo: {} });
    expect(exp.statusCode, JSON.stringify(exp.json())).toBe(200);
    const armyId = (exp.json() as { armyId: string }).armyId;
    await db.update(armies).set({ arrivesAt: new Date(Date.now() - 1000) }).where(eq(armies.id, armyId));
    await db.update(jobs).set({ endsAt: new Date(Date.now() - 1000) }).where(and(eq(jobs.refId, armyId), eq(jobs.kind, "mission")));
    const redis2 = createRedis();
    await runDueJobs(db, new Publisher(redis2), logger);
    await redis2.quit().catch(() => {});
    const [after] = await db.select().from(armies).where(eq(armies.id, armyId));
    expect(after?.status).toBe("returning");
    const outcome = (await call("GET", `/api/matches/${matchId}/feed`)).json() as { items: { kind: string; text: string }[] };
    expect(outcome.items.some((i) => i.kind === "expedition.returned")).toBe(true);

    // The last stand is refused while the ice is far from the capital.
    const ls = await call("POST", `/api/matches/${matchId}/last-stand`, { targetRegionId: capR.neighbors[0]! });
    expect(ls.statusCode).toBe(409);
  });

  it("daily objectives award score and bounties pay out to the winner of a battle", async () => {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId));
    const [me] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.isAi, false)));
    const capital = me!.capitalRegionId!;
    const now = new Date();
    // Day 0's objective is picked by the seeded rng; force a stock objective so the result is deterministic.
    await db.transaction((tx) => pickObjective(tx, m!, 0, () => 0.4));
    await db.update(dailyObjectives).set({ key: "food" }).where(and(eq(dailyObjectives.matchId, matchId), eq(dailyObjectives.day, 0)));
    await db.update(matchRegions).set({ food: 99_999 }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital)));
    await db.transaction((tx) => resolveObjective(tx, m!, 0, now));
    const [obj] = await db.select().from(dailyObjectives).where(and(eq(dailyObjectives.matchId, matchId), eq(dailyObjectives.day, 0)));
    expect(obj?.winnerPlayerId).toBe(me!.id);
    const [ms] = await db.select().from(matchMilestones).where(and(eq(matchMilestones.matchId, matchId), eq(matchMilestones.key, "day_0")));
    expect(ms?.playerId).toBe(me!.id);
    // A bounty on a neighbour, claimed by winning a battle there: the reward lands in the capital.
    const target = regionById(capital)!.neighbors[0]!;
    await db.transaction((tx) => placeBounty(tx, m!, { kind: "region", regionId: target, amount: { wood: 250, iron: 10 }, reason: "test" }, now));
    const [before] = await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital)));
    const claimed = await db.transaction((tx) => claimBounties(tx, m!, me!.id, target, null, now));
    expect(claimed).toBe(1);
    const [after] = await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital)));
    expect(after!.wood - before!.wood).toBeGreaterThanOrEqual(249);
    expect((after!.special as Record<string, number>).iron ?? 0).toBeGreaterThanOrEqual(10);
    const open = await db.select().from(bounties).where(and(eq(bounties.matchId, matchId), eq(bounties.regionId, target)));
    expect(open[0]?.claimedBy).toBe(me!.id);
    const feed = (await call("GET", `/api/matches/${matchId}/feed`)).json() as { items: { kind: string }[] };
    expect(feed.items.some((i) => i.kind === "objective.won")).toBe(true);
    expect(feed.items.some((i) => i.kind === "bounty.claimed")).toBe(true);
    // Titles and the objective show up on the public surfaces.
    const state = matchStateView.parse((await call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.objective?.day).toBe(0);
    expect(state.bounties.length).toBe(0);
  });

  it("the leader competes for objectives at a handicap and tribute is sized to the victim", () => {
    const scores = [
      { playerId: "leader", value: 100 },
      { playerId: "second", value: 70 },
      { playerId: "third", value: 10 },
    ];
    expect(objectiveWinner(scores, "leader", 0.6)?.playerId).toBe("second");
    expect(objectiveWinner(scores, "leader", 1)?.playerId).toBe("leader");
    expect(objectiveWinner(scores, "second", 0.6)?.playerId).toBe("leader");
    expect(objectiveWinner([{ playerId: "leader", value: 0 }], "leader", 0.6)).toBeUndefined();
    const c = balance.ai;
    expect(tributeDemand({ wood: 10_000 }, "wood")).toBe(Math.floor(10_000 * c.tributeShare));
    expect(tributeDemand({ wood: 10 }, "wood")).toBe(c.tributeMin);
    expect(tributeDemand({ wood: 10_000_000 }, "wood")).toBe(c.tributeMax);
    expect(tributeDemand({}, "wood")).toBe(c.tributeMin);
    // The AI pays a demand under a tenth of its stock, so a sized demand is payable.
    expect(tributeDemand({ wood: 5000 }, "wood")).toBeLessThanOrEqual(500);
  });

  it("a frozen capital moves to the best unfrozen region, and a player with nothing left is out", async () => {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId));
    const [me] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.isAi, false)));
    const capital = me!.capitalRegionId!;
    const other = regionById(capital)!.neighbors[0]!;
    // An earlier case froze this neighbour; thaw it so it can take the capital.
    await db.update(matchRegions).set({ frozenAt: null, iceFactor: 1, evacuatedAt: null }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, other)));
    await db.transaction((tx) => foundCapital(tx, matchId, me!.id, other, new Date()));
    await db.update(players).set({ capitalRegionId: capital }).where(eq(players.id, me!.id));
    await db.update(matchRegions).set({ isCapital: false }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, other)));
    await db.update(matchRegions).set({ isCapital: true, popWorkers: 40 }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital)));
    const at = new Date();
    await db.update(matchRegions).set({ frozenAt: at, popWorkers: 0 }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, capital)));
    await db.transaction((tx) => settleFrozenCapitals(tx, m!, at, new Map([[me!.id, [capital]]])));
    const [moved] = await db.select().from(players).where(eq(players.id, me!.id));
    expect(moved?.capitalRegionId).toBe(other);
    expect(moved?.eliminatedAt).toBeNull();
    const [row] = await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, other)));
    expect(row?.isCapital).toBe(true);
    const feed = (await call("GET", `/api/matches/${matchId}/feed`)).json() as { items: { kind: string }[] };
    expect(feed.items.some((i) => i.kind === "capital.moved")).toBe(true);
    // Now the last region freezes too: out of the match.
    await db.update(matchRegions).set({ frozenAt: at }).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, other)));
    await db.transaction((tx) => settleFrozenCapitals(tx, m!, at, new Map([[me!.id, [other]]])));
    const [gone] = await db.select().from(players).where(eq(players.id, me!.id));
    expect(gone?.eliminatedAt).not.toBeNull();
    expect(gone?.capitalRegionId).toBeNull();
  });
});
