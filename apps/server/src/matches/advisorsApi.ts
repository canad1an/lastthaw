import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { advisorKind, advisorSettings, type AdvisorKind } from "@lastthaw/shared";
import { idParams } from "./params.js";
import type { Db } from "../db/client.js";
import { advisors, jobs, marketOrders, matches, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { matchNow } from "../sim/clock.js";
import { drawWageUpTo, runPass, startedWork, wageFor } from "../sim/advisors.js";
import { config } from "../config.js";
import { advisorTargetBody, balance, regionById, RESOURCE_WORTH, type ChancellorEvent } from "@lastthaw/shared";
import { matchRegions } from "../db/schema.js";
import { areAllied } from "../sim/alliances.js";
import { cancelMarketOrder } from "./marketApi.js";
import { cancelPendingJob } from "./jobsApi.js";

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

const kindParams = idParams.extend({ kind: advisorKind });

/**
 * Advisors: hire, set up, fire and prod the Economic advisor. No hiring fee: the first hour's wage is charged on
 * hiring and then every game hour by the tick; fire and rehire freely.
 */
/**
 * A pass right now, with the same rules the advisor's own clock applies: the match must be running, the advisor hired,
 * paid, past its first charged hour, and not run within the last runEveryMinutes. Reached only from the dev-only route
 * and from tests: in play, passes come on the advisor's schedule and nothing hurries them.
 */
export async function forcePass(db: Db, publisher: Publisher, matchId: string, userId: string, kind: AdvisorKind) {
  const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!m) throw httpError(404, "match not found");
  if (m.status !== "running") throw httpError(409, "the match is not running");
  const [p] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, userId))).limit(1);
  if (!p) throw httpError(403, "not your match");
  const [a] = await db.select().from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, kind), isNull(advisors.firedAt))).limit(1);
  if (!a) throw httpError(404, "no such advisor");
  if (a.unpaidSince) throw httpError(409, "your advisor is unpaid and will not work until the wage is met");
  if (!startedWork(a)) throw httpError(409, "the first hour's wage is charged at the next tick, within five minutes of hiring; passes start once it is paid");
  const now = matchNow(m);
  if (a.lastPassAt && now.getTime() - a.lastPassAt.getTime() < (balance.advisors.runEveryMinutes * 60_000) / m.speed) throw httpError(429, `the advisor made a pass ${Math.max(1, Math.round(((now.getTime() - a.lastPassAt.getTime()) / 60_000) * m.speed))} game minutes ago`);
  const report = await runPass(db, m, p, a, now, publisher);
  return { ok: true, report };
}

export async function advisorRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  async function loadContext(matchId: string, userId: string) {
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (m.status !== "running" || m.pausedAt) throw httpError(409, "the match is not running");
    const [p] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, userId))).limit(1);
    if (!p || p.eliminatedAt) throw httpError(403, "not a player in this match");
    return { m, p };
  }

  app.post("/api/matches/:id/advisors/:kind/hire", async (req) => {
    const user = requireUser(req);
    const { id: matchId, kind } = kindParams.parse(req.params);
    const { m, p } = await loadContext(matchId, user.id);
    const [existing] = await db.select().from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, kind))).limit(1);
    if (existing && !existing.firedAt) throw httpError(409, "that advisor is already hired");
    const now = matchNow(m);
    const hourMs = 3600_000 / m.speed;
    if (existing?.firedAt) {
      const back = new Date(existing.firedAt.getTime() + balance.advisors.rehireCooldownHours * hourMs);
      if (back > now) throw httpError(409, `you fired this advisor; they will take you back in ${Math.max(1, Math.ceil(((back.getTime() - now.getTime()) / 3600_000) * m.speed))} game hour${Math.ceil(((back.getTime() - now.getTime()) / 3600_000) * m.speed) === 1 ? "" : "s"}`);
    }
    const wage = await wageFor(db, m, p.id);
    // Nothing is paid on hiring: the first hour's wage is charged by the next tick like every hour after it. Hiring and
    // firing to dodge a wage buys nothing, since a fired advisor stays away for rehireCooldownHours.
    const paidUntil = now;
    if (existing) await db.update(advisors).set({ hiredAt: now, paidUntil, firedAt: null, unpaidSince: null, lastPassAt: null, campaigns: [] }).where(eq(advisors.id, existing.id));
    else await db.insert(advisors).values({ matchId, playerId: p.id, kind, hiredAt: now, paidUntil, settings: advisorSettings.parse({}) });
    await publisher.toPlayer(matchId, p.id, "advisor.hired", { kind });
    return { ok: true, wage };
  });

  app.post("/api/matches/:id/advisors/:kind/fire", async (req) => {
    const user = requireUser(req);
    const { id: matchId, kind } = kindParams.parse(req.params);
    const { m, p } = await loadContext(matchId, user.id);
    const now = matchNow(m);
    const hourMs = 3600_000 / m.speed;
    const charged = await db.transaction(async (tx) => {
      const [a] = await tx.select().from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, kind), isNull(advisors.firedAt))).for("update");
      if (!a) throw httpError(404, "no such advisor");
      // The hours used since the last charge are billed on the way out, and at least one if none was ever charged, so a
      // hire, a pass and a firing are never free. What the stores cannot cover is let go.
      const used = Math.ceil(Math.max(0, now.getTime() - a.paidUntil.getTime()) / hourMs);
      const hours = startedWork(a) ? used : Math.max(1, used);
      let taken: Record<string, number> = {};
      if (hours > 0) {
        const wage = await wageFor(tx, m, p.id);
        const bill: Record<string, number> = {};
        for (const [k, v] of Object.entries(wage)) bill[k] = v * hours;
        taken = await drawWageUpTo(tx, m, p, bill);
      }
      await tx.update(advisors).set({ firedAt: now, paidUntil: now }).where(eq(advisors.id, a.id));
      return taken;
    });
    await publisher.toPlayer(matchId, p.id, "advisor.fired", { kind });
    return { ok: true, charged };
  });

  app.put("/api/matches/:id/advisors/:kind/settings", async (req) => {
    const user = requireUser(req);
    const { id: matchId, kind } = kindParams.parse(req.params);
    const { p } = await loadContext(matchId, user.id);
    const body = advisorSettings.parse(req.body);
    const updated = await db
      .update(advisors)
      .set({ settings: body })
      .where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, kind), isNull(advisors.firedAt)))
      .returning({ id: advisors.id });
    if (!updated.length) throw httpError(404, "no such advisor");
    await publisher.toPlayer(matchId, p.id, "advisor.settings", { kind });
    return { ok: true, settings: body };
  });

  /** Local testing only: in play nobody can hurry an advisor, so this route does not exist without DEV_TOOLS. */
  app.post("/api/matches/:id/advisors/:kind/run", async (req) => {
    const user = requireUser(req);
    const { id: matchId, kind } = kindParams.parse(req.params);
    if (!config().DEV_TOOLS) throw httpError(404, "passes cannot be forced: the advisor works on their own clock");
    return forcePass(db, publisher, matchId, user.id, kind);
  });


  /**
   * The Chancellor's clean slate: every open listing of the player's is withdrawn (goods back on the shelf), every
   * queued research is cancelled and refunded, and a hired, paid Chancellor makes a fresh pass at once from the settings.
   */
  app.post("/api/matches/:id/advisors/chancellor/clean-slate", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const { m, p } = await loadContext(matchId, user.id);
    const open = await db.select({ id: marketOrders.id }).from(marketOrders).where(and(eq(marketOrders.matchId, matchId), eq(marketOrders.playerId, p.id), eq(marketOrders.status, "open")));
    let listings = 0;
    for (const o of open) {
      await cancelMarketOrder(db, m, p, o.id);
      listings += 1;
    }
    const queued = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.matchId, matchId), eq(jobs.playerId, p.id), eq(jobs.kind, "research"), isNull(jobs.completedAt), isNull(jobs.cancelledAt)))
      .orderBy(asc(jobs.startsAt));
    // Later first, so the refund of each is whole and nothing shifts under the next.
    for (const j of [...queued].reverse()) await db.transaction((tx) => cancelPendingJob(tx, m, p, j.id));
    let passed = false;
    const [theo] = await db.select().from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, "chancellor"), isNull(advisors.firedAt))).limit(1);
    if (theo && !theo.unpaidSince && startedWork(theo)) {
      await runPass(db, m, p, theo, matchNow(m), publisher);
      passed = true;
    }
    await publisher.toPlayer(matchId, p.id, "region.updated", {});
    return { ok: true, listings, research: queued.length, passed };
  });

  /**
   * The Chancellor's book: every listing he placed and every offer he took, newest first, read back from the market
   * orders he touched. A listing he placed is one line when it goes up and another when someone buys it.
   */
  app.get("/api/matches/:id/advisors/chancellor/history", async (req) => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const [p] = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.userId, user.id))).limit(1);
    if (!p) throw httpError(403, "not a player in this match");
    const rows = await db
      .select()
      .from(marketOrders)
      .where(and(eq(marketOrders.matchId, matchId), or(and(eq(marketOrders.playerId, p.id), eq(marketOrders.placedByAdvisor, true)), and(eq(marketOrders.filledByPlayerId, p.id), eq(marketOrders.filledByAdvisor, true)))))
      .orderBy(desc(sql`coalesce(${marketOrders.filledAt}, ${marketOrders.createdAt})`))
      .limit(300);
    const others = [...new Set(rows.flatMap((o) => [o.playerId, o.filledByPlayerId]).filter((id): id is string => !!id && id !== p.id))];
    const names = new Map<string, string>();
    if (others.length) for (const r of await db.select({ id: players.id, name: players.name }).from(players).where(inArray(players.id, others))) names.set(r.id, r.name);
    const worth = (res: string, n: number) => n * (RESOURCE_WORTH[res] ?? 1);
    const events: ChancellorEvent[] = [];
    for (const o of rows) {
      const ofFair = worth(o.askResource, o.askAmount) / Math.max(1e-9, worth(o.offerResource, o.offerAmount));
      if (o.playerId === p.id) {
        events.push({ id: `${o.id}:listed`, at: o.createdAt.toISOString(), action: o.status === "cancelled" ? "withdrawn" : "listed", gave: { resource: o.offerResource, amount: o.offerAmount }, got: { resource: o.askResource, amount: o.askAmount }, regionId: o.regionId, with: null, ofFair, open: o.status === "open" });
        if (o.status === "filled" && o.filledAt) events.push({ id: `${o.id}:sold`, at: o.filledAt.toISOString(), action: "sold", gave: { resource: o.offerResource, amount: o.offerAmount }, got: { resource: o.askResource, amount: o.askAmount }, regionId: o.regionId, with: names.get(o.filledByPlayerId ?? "") ?? "someone", ofFair, open: false });
      } else if (o.filledAt) {
        events.push({ id: `${o.id}:bought`, at: o.filledAt.toISOString(), action: "bought", gave: { resource: o.askResource, amount: o.askAmount }, got: { resource: o.offerResource, amount: o.offerAmount }, regionId: null, with: names.get(o.playerId) ?? "someone", ofFair, open: false });
      }
    }
    events.sort((a, b) => b.at.localeCompare(a.at));
    return { events };
  });

  /** Mark or unmark a region as a target for the Military advisor, from the map. */
  app.post("/api/matches/:id/advisors/military/targets", async (req) => {
    const user = requireUser(req);
    const { id: matchId } = idParams.parse(req.params);
    const { regionId, add } = advisorTargetBody.parse(req.body);
    const { m, p } = await loadContext(matchId, user.id);
    if (!regionById(regionId)) throw httpError(400, "unknown region");
    const [a] = await db.select().from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, p.id), eq(advisors.kind, "military"), isNull(advisors.firedAt))).limit(1);
    if (!a) throw httpError(404, "no Military advisor");
    const settings = advisorSettings.parse(a.settings ?? {});
    let targets = settings.targets.filter((t) => t !== regionId);
    if (add) {
      const [row] = await db.select({ owner: matchRegions.ownerPlayerId, frozenAt: matchRegions.frozenAt }).from(matchRegions).where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.regionId, regionId))).limit(1);
      if (row?.owner === p.id) throw httpError(400, "that region is already yours");
      if (row?.frozenAt) throw httpError(400, "that region is frozen");
      if (row?.owner && (await areAllied(db, matchId, p.id, row.owner))) throw httpError(400, "that region belongs to an ally");
      if (targets.length >= balance.advisors.military.maxTargets) throw httpError(400, `at most ${balance.advisors.military.maxTargets} targets at a time`);
      targets = [...targets, regionId];
    }
    await db.update(advisors).set({ settings: { ...settings, targets } }).where(eq(advisors.id, a.id));
    void m;
    await publisher.toPlayer(matchId, p.id, "advisor.targets", { targets });
    return { ok: true, targets };
  });
}
