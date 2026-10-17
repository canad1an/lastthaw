/**
 * Load harness: many matches, many simulated players, against a running API
 * with the worker and AI processes alongside. Measures what players feel
 * (request latency, errors) and what the simulation feels (tick age, overdue
 * jobs, heartbeats) while the stack carries far more than it has so far.
 *
 *   LOAD_MATCHES=30 LOAD_HUMANS=300 LOAD_SPEED=10 LOAD_MINUTES=420 API_URL=http://localhost:3001 \
 *     npx tsx --env-file-if-exists=../../.env src/scripts/load.ts
 *   npx tsx --env-file-if-exists=../../.env src/scripts/load.ts --cleanup   (removes the load matches and users)
 *
 * The API must run with LOAD_TEST=1 (no per-address rate limit: every simulated
 * player comes from this machine) and DEV_TOOLS=true (dev start). Never point
 * this at production.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { jobs, matches, players, users } from "../db/schema.js";
import { createRedis } from "../redis.js";

const API = process.env.API_URL ?? "http://localhost:3001";
const ORIGIN = process.env.PUBLIC_URL ?? "http://localhost:5173";
const MATCHES = Number(process.env.LOAD_MATCHES ?? 30);
const HUMANS = Number(process.env.LOAD_HUMANS ?? 300);
const SPEED = Number(process.env.LOAD_SPEED ?? 10);
const MINUTES = Number(process.env.LOAD_MINUTES ?? 60);
const POLL_MS = Number(process.env.LOAD_POLL_MS ?? 15_000);
const COMMANDS_PER_MIN = Number(process.env.LOAD_COMMANDS_PER_MIN ?? 2);
const OUT = process.env.LOAD_OUT ?? "load-report.jsonl";
const ADMIN = { email: process.env.LOAD_ADMIN_EMAIL ?? "bob@example.test", password: process.env.LOAD_ADMIN_PASSWORD ?? "playtest-pass-2" };
const TAG = "Load";
if (API.includes("lastthaw.com")) throw new Error("the load harness never runs against production");

const db = createDb();

// ------------------------------------------------------------ a tiny client
class Client {
  cookie = "";
  constructor(readonly name: string) {}
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; ms: number }> {
    const t = performance.now();
    const init: RequestInit = { method, headers: { cookie: this.cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, init);
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) {
      const jar = new Map(this.cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0]!, c]));
      for (const c of set) jar.set(c.split(";")[0]!.split("=")[0]!, c.split(";")[0]!);
      this.cookie = [...jar.values()].join("; ");
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, json, ms: performance.now() - t };
  }
}

// ------------------------------------------------------------ measurements
const lat: Record<string, number[]> = {};
const errs: Record<string, number> = {};
let requests = 0;
function record(kind: string, r: { status: number; ms: number }) {
  requests += 1;
  const xs = (lat[kind] ??= []);
  xs.push(r.ms);
  // Keep the last 100k samples per kind: enough for percentiles, bounded memory over a night.
  if (xs.length > 120_000) xs.splice(0, xs.length - 100_000);
  if (r.status >= 500 || r.status === 429) errs[`${kind}:${r.status}`] = (errs[`${kind}:${r.status}`] ?? 0) + 1;
}
function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
}
async function simHealth() {
  const redis = createRedis();
  const beat = async (k: string) => {
    const v = await redis.get(k).catch(() => null);
    return v ? Math.round((Date.now() - Date.parse(v)) / 1000) : null;
  };
  const worker = await beat("lt-heartbeat:worker");
  const ai = await beat("lt-heartbeat:ai");
  await redis.quit().catch(() => {});
  const [tick] = await db
    .select({ maxAge: sql<number>`coalesce(max(extract(epoch from (now() + make_interval(secs => ${matches.clockOffsetSeconds}) - ${matches.lastTickAt}))), 0)::int`, running: sql<number>`count(*)::int` })
    .from(matches)
    .where(and(eq(matches.status, "running"), like(matches.name, `${TAG} %`)));
  const [due] = await db
    .select({ overdue: sql<number>`count(*) filter (where ${jobs.endsAt} < now() - interval '60 seconds')::int`, open: sql<number>`count(*)::int` })
    .from(jobs)
    .innerJoin(matches, eq(matches.id, jobs.matchId))
    .where(and(isNull(jobs.completedAt), isNull(jobs.cancelledAt), isNull(jobs.waitingFor), eq(matches.status, "running"), like(matches.name, `${TAG} %`)));
  const [pg] = await db.select({ connections: sql<number>`(select count(*) from pg_stat_activity where datname = current_database())::int` }).from(matches).limit(1);
  return { workerBeatSeconds: worker, aiBeatSeconds: ai, running: tick?.running ?? 0, maxTickAgeSeconds: tick?.maxAge ?? 0, jobsOpen: due?.open ?? 0, jobsOverdue: due?.overdue ?? 0, pgConnections: pg?.connections ?? 0 };
}
async function report(label: string) {
  const health = await simHealth();
  const line = {
    at: new Date().toISOString(),
    label,
    requests,
    latencyMs: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, { n: v.length, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99), max: Math.round(v.reduce((a, b) => (b > a ? b : a), 0)) }])),
    errors: errs,
    ...health,
    memMb: Math.round(process.memoryUsage().rss / 1048576),
  };
  appendFileSync(OUT, JSON.stringify(line) + "\n");
  console.log(`${line.at} ${label}: ${requests} req · state p95 ${line.latencyMs.state?.p95 ?? "-"}ms p99 ${line.latencyMs.state?.p99 ?? "-"}ms · cmd p95 ${line.latencyMs.command?.p95 ?? "-"}ms · errors ${JSON.stringify(errs)} · tick age ${health.maxTickAgeSeconds}s · jobs open ${health.jobsOpen} overdue ${health.jobsOverdue} · worker ${health.workerBeatSeconds}s ai ${health.aiBeatSeconds}s · pg ${health.pgConnections}`);
}

// ------------------------------------------------------------ cleanup
async function cleanup() {
  // A running worker ticks these matches; a delete can deadlock against a tick, so try again a few times.
  let gone: Array<{ id: string }> = [];
  for (let attempt = 1; ; attempt++) {
    try {
      gone = await db.delete(matches).where(like(matches.name, `${TAG} %`)).returning({ id: matches.id });
      break;
    } catch (e) {
      if (attempt >= 8 || !/deadlock/i.test(String((e as Error).message))) throw e;
      console.log(`cleanup deadlocked against the worker, retry ${attempt}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const goneUsers = await db.delete(users).where(like(users.email, "load-%@example.test")).returning({ id: users.id });
  console.log(`removed ${gone.length} load matches and ${goneUsers.length} load users`);
}

// ------------------------------------------------------------ the run
async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup();
    await db.close();
    return;
  }
  writeFileSync(OUT, "");
  const health = await fetch(`${API}/api/health`).then((r) => r.json() as Promise<{ devTools: boolean }>);
  if (!health.devTools) throw new Error("the API needs DEV_TOOLS=true for dev start");
  const admin = new Client("admin");
  const login = await admin.call("POST", "/api/auth/login", ADMIN);
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);

  // Players: register, verify and approve straight in the database.
  console.log(`registering ${HUMANS} players...`);
  const humans: Client[] = [];
  for (let i = 0; i < HUMANS; i++) {
    const c = new Client(`load-${i}`);
    const email = `load-${i}@example.test`;
    const r = await c.call("POST", "/api/auth/register", { email, password: "load-test-pass", displayName: `Load ${i}` });
    if (r.status === 409) await c.call("POST", "/api/auth/login", { email, password: "load-test-pass" });
    else if (r.status !== 201) throw new Error(`register ${i}: ${r.status} ${JSON.stringify(r.json)}`);
    humans.push(c);
  }
  await db.update(users).set({ emailVerifiedAt: new Date(), approvedAt: new Date() }).where(like(users.email, "load-%@example.test"));
  for (const c of humans) await c.call("GET", "/api/auth/me");

  // Matches: created by the admin, humans spread across them, AI fill the rest, started at once.
  console.log(`creating ${MATCHES} matches at ${SPEED}x...`);
  const matchIds: string[] = [];
  for (let m = 0; m < MATCHES; m++) {
    const r = await admin.call("POST", "/api/matches", { name: `${TAG} ${m + 1} ${Date.now().toString(36)}`, speed: SPEED, startsInMinutes: 60, kind: "public", aiFillTo: 20, aiDifficulty: "mixed" });
    if (r.status !== 201) throw new Error(`create match ${m}: ${r.status} ${JSON.stringify(r.json)}`);
    matchIds.push((r.json as { id: string }).id);
  }
  const matchOf = new Map<Client, string>();
  humans.forEach((c, i) => matchOf.set(c, matchIds[i % matchIds.length]!));
  for (const c of humans) {
    const r = await c.call("POST", `/api/matches/${matchOf.get(c)}/join`, {});
    if (r.status !== 201 && r.status !== 200) throw new Error(`join: ${r.status} ${JSON.stringify(r.json)}`);
  }
  for (const id of matchIds) {
    const r = await admin.call("POST", `/api/matches/${id}/dev/start`, {});
    if (r.status !== 200) throw new Error(`start ${id}: ${r.status}`);
  }
  console.log(`running for ${MINUTES} minutes: ${HUMANS} players polling every ${POLL_MS / 1000}s and sending ${COMMANDS_PER_MIN} commands a minute each`);

  // Each player: poll the state, now and then act on it (workers, a hut, the first techs, a few warriors).
  const stopAt = Date.now() + MINUTES * 60_000;
  const BUILDS = ["huts", "storehouse", "lumber_camp", "quarry", "hunting_grounds"];
  const TECHS = ["fire_making", "flint_tools", "agriculture", "weaving", "stone_axes", "bronze_working"];
  const player = async (c: Client, i: number) => {
    const matchId = matchOf.get(c)!;
    await new Promise((r) => setTimeout(r, (i / HUMANS) * POLL_MS));
    let capital: string | null = null;
    let tick = 0;
    while (Date.now() < stopAt) {
      const st = await c.call("GET", `/api/matches/${matchId}/state`);
      record("state", st);
      if (st.status === 200) {
        const s = st.json as { me: { capitalRegionId: string | null }; match: { status: string } };
        capital = s.me.capitalRegionId;
        if (s.match.status === "finished") return;
      }
      tick += 1;
      const perPoll = (COMMANDS_PER_MIN * POLL_MS) / 60_000;
      if (capital && Math.random() < perPoll) {
        const roll = Math.random();
        const cmd =
          roll < 0.3
            ? c.call("POST", `/api/matches/${matchId}/regions/${capital}/assign`, { food: 0.4 + Math.random() * 0.2, wood: 0.3, stone: 0.3 })
            : roll < 0.6
              ? c.call("POST", `/api/matches/${matchId}/regions/${capital}/build`, { buildingId: BUILDS[tick % BUILDS.length] })
              : roll < 0.85
                ? c.call("POST", `/api/matches/${matchId}/research`, { techId: TECHS[tick % TECHS.length] })
                : c.call("POST", `/api/matches/${matchId}/regions/${capital}/train`, { unitId: "warrior", qty: 2 });
        record("command", await cmd);
      }
      if (tick % 4 === 0) record("leaderboard", await c.call("GET", `/api/matches/${matchId}/leaderboard`));
      if (tick % 6 === 0) record("feed", await c.call("GET", `/api/matches/${matchId}/feed`));
      await new Promise((r) => setTimeout(r, POLL_MS * (0.8 + Math.random() * 0.4)));
    }
  };
  const reporter = setInterval(() => void report("minute"), 60_000);
  await Promise.all(humans.map((c, i) => player(c, i)));
  clearInterval(reporter);
  await report("final");
  console.log(`done; report in ${OUT}`);
  await db.close();
}

main().catch(async (err) => {
  console.error(err);
  await db.close();
  process.exit(1);
});
