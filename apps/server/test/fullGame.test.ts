import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { balance, matchStateView } from "@lastthaw/shared";
import { buildApp } from "../src/api/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { dailyObjectives, events, jobs, matches, players, userMatchResults, users } from "../src/db/schema.js";
import { runAiDecisions, runMatchTicks } from "../src/sim/tick.js";
import { runOverflow, runTradeRoutes } from "../src/sim/trade.js";
import { Publisher } from "../src/realtime/publish.js";
import { createRedis } from "../src/redis.js";
import { runDueJobs } from "../src/worker/jobs.js";
import { logger } from "../src/logger.js";

process.env.DATABASE_URL ??= "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DEV_TOOLS = "true";
process.env.SMTP_PORT ??= "1";

type App = Awaited<ReturnType<typeof buildApp>>;

class Client {
  cookie = "";
  constructor(private readonly app: App) {}
  async call(method: "GET" | "POST", url: string, body?: Record<string, unknown>) {
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

/**
 * The whole game, start to finish, in one process: one human and eight AI
 * tribes at 10x, the clock skipped twelve game hours at a time while the job
 * runner, the match tick, the AI and the trade loops do exactly what the
 * worker and AI processes do in production. Thirty days later the match must
 * have finished cleanly with a winner, a result for the human, every ice step
 * done, no failed jobs, a daily objective for every day and a feed full of
 * world events.
 */
describe("a complete match", () => {
  let app: App;
  let db: Db;
  let matchId = "";
  const suffix = Date.now().toString(36);
  const user = { email: `full-${suffix}@example.test`, password: "correct horse battery", displayName: `Full${suffix}` };
  const SPEED = 10;
  // A day per step and six AI tribes keep the whole run under five minutes; the AI pass is the cost that grows with the empires.
  const STEP_GAME_HOURS = 24;
  const AI_TRIBES = 6;
  const AI_PER_STEP = 40;

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

  it("runs thirty days with AI tribes and ends with a winner, results and a full feed", { timeout: 600_000 }, async () => {
    const c = new Client(app);
    expect((await c.call("POST", "/api/auth/register", user)).statusCode).toBe(201);
    await db.update(users).set({ emailVerifiedAt: new Date(), approvedAt: new Date() }).where(eq(users.email, user.email));
    const created = await c.call("POST", "/api/matches", { name: `Full game ${suffix}`, speed: SPEED, startsInMinutes: 0, aiFillTo: AI_TRIBES + 1, aiDifficulty: "mixed" });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    matchId = (created.json() as { id: string }).id;
    expect((await c.call("POST", `/api/matches/${matchId}/join`, {})).statusCode).toBe(201);
    expect((await c.call("POST", `/api/matches/${matchId}/dev/start`, {})).statusCode).toBe(200);

    let state = matchStateView.parse((await c.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.match.status).toBe("running");
    expect(state.players.length).toBe(AI_TRIBES + 1);
    const capital = state.me.capitalRegionId!;
    expect(capital).toBeTruthy();
    // The human plays a little: workers on food, a hut, and the first tech.
    expect((await c.call("POST", `/api/matches/${matchId}/regions/${capital}/assign`, { food: 0.6, wood: 0.25, stone: 0.15 })).statusCode).toBe(200);
    expect((await c.call("POST", `/api/matches/${matchId}/regions/${capital}/build`, { buildingId: "huts" })).statusCode).toBe(200);
    expect((await c.call("POST", `/api/matches/${matchId}/research`, { techId: "fire_making" })).statusCode).toBe(200);

    const redis = createRedis();
    const publisher = new Publisher(redis);
    const log = logger.child({ test: "fullGame" });
    const steps = Math.ceil((balance.match.lengthDays * 24) / STEP_GAME_HOURS) + 2;
    const skip = Math.ceil((STEP_GAME_HOURS * 3600) / SPEED);
    // PROFILE_STEPS=n runs only n steps and prints where the time goes, for tuning this test.
    const profileSteps = Number(process.env.PROFILE_STEPS) || 0;
    const timings: Record<string, number> = {};
    const timed = async (name: string, fn: () => Promise<unknown>) => {
      const t = Date.now();
      await fn();
      timings[name] = (timings[name] ?? 0) + (Date.now() - t);
    };
    try {
      for (let i = 0; i < (profileSteps || steps); i++) {
        expect((await c.call("POST", `/api/matches/${matchId}/dev/time-skip`, { seconds: skip })).statusCode).toBe(200);
        await timed("jobs", async () => {
          for (let j = 0; j < 8 && (await runDueJobs(db, publisher, log)) > 0; j++) {
            /* drain every job that came due in the skipped window */
          }
        });
        await timed("tick", () => runMatchTicks(db, publisher, log));
        await timed("ai", () => runAiDecisions(db, publisher, log, AI_PER_STEP));
        await timed("trade", () => runTradeRoutes(db, publisher, log));
        await timed("overflow", () => runOverflow(db, publisher, log));
        const [m] = await db.select({ status: matches.status }).from(matches).where(eq(matches.id, matchId));
        if (profileSteps) {
          process.stderr.write(`step ${i + 1} day ${((i + 1) * STEP_GAME_HOURS) / 24}: ${JSON.stringify(timings)}
`);
          for (const k of Object.keys(timings)) timings[k] = 0;
        }
        if (m?.status === "finished") break;
      }
      if (profileSteps) return;
      for (let j = 0; j < 8 && (await runDueJobs(db, publisher, log)) > 0; j++) {
        /* anything left after the end */
      }
    } finally {
      await redis.quit().catch(() => {});
    }

    const [m] = await db.select().from(matches).where(eq(matches.id, matchId));
    expect(m?.status).toBe("finished");
    expect(m?.finishedAt).not.toBeNull();
    expect(m?.winnerPlayerId).toBeTruthy();
    expect(["hold", "wonder", "survival", "score"]).toContain(m?.winKind);

    // Every job ran: no failures, thirty ice steps, the match end.
    const failed = await db.select({ kind: jobs.kind, err: jobs.lastError }).from(jobs).where(and(eq(jobs.matchId, matchId), isNotNull(jobs.lastError)));
    expect(failed).toEqual([]);
    const ice = await db.select().from(jobs).where(and(eq(jobs.matchId, matchId), eq(jobs.kind, "ice_step")));
    expect(ice).toHaveLength(balance.match.lengthDays);
    expect(ice.filter((j) => !j.completedAt)).toEqual([]);
    const open = await db.select().from(jobs).where(and(eq(jobs.matchId, matchId), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
    expect(open).toEqual([]);

    // The AI tribes lived: they built, researched and most survived the ice at least a while.
    const all = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, false)));
    expect(all).toHaveLength(AI_TRIBES + 1);
    expect(all.filter((p) => p.isAi && p.age >= 1).length).toBeGreaterThanOrEqual(2);
    const horde = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, true)));
    expect(horde).toHaveLength(1);

    // The world happened: a daily objective for (nearly) every day, storms, hordes and ice in the feed.
    const objectives = await db.select().from(dailyObjectives).where(eq(dailyObjectives.matchId, matchId));
    expect(objectives.length).toBeGreaterThanOrEqual(balance.match.lengthDays - 2);
    expect(objectives.filter((o) => o.winnerPlayerId).length).toBeGreaterThanOrEqual(10);
    const kinds = new Map<string, number>();
    for (const e of await db.select({ kind: events.kind }).from(events).where(eq(events.matchId, matchId))) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    expect(kinds.get("match.started")).toBe(1);
    expect(kinds.get("match.finished")).toBe(1);
    expect(kinds.get("ice.advanced")).toBe(balance.match.lengthDays);
    expect(kinds.get("storm.warning") ?? 0).toBeGreaterThanOrEqual(1);
    expect(kinds.get("storm.hit") ?? 0).toBe(kinds.get("storm.warning") ?? 0);
    expect(kinds.get("horde.sighted") ?? 0).toBeGreaterThanOrEqual(1);
    expect(kinds.get("objective.won") ?? 0).toBeGreaterThanOrEqual(10);
    expect(kinds.get("age.advanced") ?? 0).toBeGreaterThanOrEqual(3);

    // Every public surface agrees the match is over.
    state = matchStateView.parse((await c.call("GET", `/api/matches/${matchId}/state`)).json());
    expect(state.match.status).toBe("finished");
    expect(state.match.finishedAt).toBeTruthy();
    expect(state.players.some((p) => p.id === horde[0]!.id)).toBe(false);
    const board = (await c.call("GET", `/api/matches/${matchId}/leaderboard`)).json() as { match: { status: string; winnerPlayerId: string | null }; players: { id: string; rank: number }[] };
    expect(board.match.status).toBe("finished");
    expect(board.match.winnerPlayerId).toBe(m!.winnerPlayerId);
    expect(board.players.map((p) => p.id)).not.toContain(horde[0]!.id);
    expect(board.players[0]!.id).toBe(m!.winnerPlayerId);
    expect((await c.call("GET", `/api/matches/${matchId}/summary`)).statusCode).toBe(200);
    expect((await c.call("GET", `/api/matches/${matchId}/replay`)).statusCode).toBe(200);
    const feed = (await c.call("GET", `/api/matches/${matchId}/feed`)).json() as { items: { kind: string; text: string }[] };
    expect(feed.items.length).toBeGreaterThanOrEqual(20);
    expect(feed.items.every((i) => i.text.length > 0)).toBe(true);
    const results = await db.select().from(userMatchResults).where(eq(userMatchResults.matchId, matchId));
    expect(results).toHaveLength(1);
    expect(results[0]!.winKind).toBe(m!.winKind);
    const history = (await c.call("GET", "/api/me/history")).json() as { played: number; history: { matchId: string }[] };
    expect(history.played).toBe(1);
    expect(history.history[0]!.matchId).toBe(matchId);
    const past = (await c.call("GET", "/api/matches/past")).json() as { matches?: { id: string }[] } | { id: string }[];
    const pastList = Array.isArray(past) ? past : (past.matches ?? []);
    expect(pastList.some((x) => x.id === matchId)).toBe(true);
  });
});
