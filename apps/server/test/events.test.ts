import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { balance, matchStateView, regionById } from "@lastthaw/shared";
import { buildApp } from "../src/api/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { jobs, matchRegions, matches, players, refugeeOffers, users } from "../src/db/schema.js";
import { Publisher } from "../src/realtime/publish.js";
import { createRedis } from "../src/redis.js";
import { stormHits } from "../src/sim/worldEvents.js";
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
});
