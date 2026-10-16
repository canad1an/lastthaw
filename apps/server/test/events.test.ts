import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { balance, matchStateView, regionById } from "@lastthaw/shared";
import { buildApp } from "../src/api/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { armies, jobs, matchRegions, matches, mercenaryOffers, players, refugeeOffers, transfers, users } from "../src/db/schema.js";
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
});
