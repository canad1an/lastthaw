/**
 * Freya, the Warden of the Thaw. Every pass she reads the ice schedule against every region you hold: the ones that
 * freeze within the warning are evacuated (people, units and what they can carry) to the safest region of yours with a
 * route, the capital is moved out of the ice's path before its wagon would be too late, and while land is being lost
 * she settles free regions on the warm side. Nothing is spared the ice; she only gets your people out ahead of it.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { balance, distanceKm, findRoute, freezeDayForLatitude, regionById, travelSeconds, unitById, type AdvisorReport, type AdvisorSuggestion } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { advisors, armies, jobs, matchRegions, players, playerTechs } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { alliesOf } from "./alliances.js";
import { relocateCapital } from "./capital.js";
import { queueTrain, sendArmy, type CommandContext } from "./commands.js";
import { evacuateRegion } from "./evacuate.js";
import { waySetsFor, type MatchRegionRow } from "./regions.js";
import { parseSettings, type AdvisorRow } from "./advisors.js";
import { notify, type MatchRow } from "../worker/jobs.js";

type PlayerRow = typeof players.$inferSelect;

const name = (id: string) => regionById(id)?.name ?? id;
const unitTotal = (units: Record<string, number>) => Object.values(units).reduce((a, b) => a + b, 0);

/** When a region freezes solid, in match time: the ice job of its freeze day, or later while a thaw pocket spares it. Null when it never freezes. */
export function freezeTimeOf(m: MatchRow, row: { regionId: string; thawUntil?: Date | null }): Date | null {
  const r = regionById(row.regionId);
  if (!r || !m.startsAt) return null;
  const day = freezeDayForLatitude(Math.abs(r.lat));
  if (day === null) return null;
  let t = m.startsAt.getTime() + (day * 86400_000) / m.speed;
  if (row.thawUntil && row.thawUntil.getTime() > t) t = row.thawUntil.getTime();
  return new Date(t);
}

/** One pass of the Warden: the clock, evacuations, the capital, then settling. */
export async function thawPass(db: Db, m: MatchRow, p: PlayerRow, a: AdvisorRow, now: Date, publisher: Publisher): Promise<AdvisorReport> {
  const c = balance.advisors.thaw;
  const settings = parseSettings(a.settings);
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
  const techs = new Set(techRows.map((t) => t.id));
  const ctx: CommandContext = { db, m, p, techs };
  const attempt = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (err) {
      return (err as Error).message ?? "refused";
    }
  };
  const skipped: Record<string, number> = {};
  const bump = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1);
  const skip = new Set(settings.skipRegions);
  const suggestions: AdvisorSuggestion[] = [];
  const hourMs = 3600_000 / m.speed;
  const dayMs = 86400_000 / m.speed;
  const matchDay = m.startsAt ? (now.getTime() - m.startsAt.getTime()) / dayMs : 0;
  const hoursLeft = (row: MatchRegionRow): number => {
    const f = freezeTimeOf(m, row);
    return f ? (f.getTime() - now.getTime()) / hourMs : Infinity;
  };
  let evacuated = 0;
  let settled = 0;
  let trained = 0;
  let moved = 0;

  const owned = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt)));
  const info = owned.map((row) => ({ row, hours: hoursLeft(row) })).sort((x, y) => x.hours - y.hours);
  const clockLimit = settings.warningHours * c.clockPeriods;
  const { roads, rails, harbors } = await waySetsFor(db, m.id, p.id, await alliesOf(db, m.id, p.id));
  const seaOk = techs.has(balance.travel.seaTech);
  const route = (from: string, to: string) => findRoute(from, to, seaOk, roads, rails, harbors);

  // 1. The clock: every region freezing within a few warning periods, soonest first.
  const clock = info
    .filter((x) => x.hours <= clockLimit)
    .map((x) => {
      const people = Math.floor(x.row.popWorkers + x.row.popSoldiers + x.row.popOccupiers);
      const goods = Math.floor(x.row.food + x.row.wood + x.row.stone);
      const state = x.row.evacuatedAt ? "evacuated" : `${people} people, ${unitTotal(x.row.units)} units, ${goods.toLocaleString("en-US")} goods`;
      const text = `${name(x.row.regionId)}: freezes in ${Math.max(0, Math.round(x.hours))} h${x.row.regionId === p.capitalRegionId ? " (your capital)" : ""}; ${state}.`;
      return { regionId: x.row.regionId, hoursLeft: Math.max(0, Math.round(x.hours)), text };
    });

  // Safe ground: regions of yours not on the clock, the latest to freeze first.
  const safe = info.filter((x) => x.hours > clockLimit && !x.row.evacuatedAt && !skip.has(x.row.regionId)).sort((x, y) => y.hours - x.hours);
  const destinationFor = (from: { row: MatchRegionRow; hours: number }): string | null => {
    if (settings.destination === "capital" && p.capitalRegionId && p.capitalRegionId !== from.row.regionId) {
      const cap = safe.find((x) => x.row.regionId === p.capitalRegionId);
      if (cap && route(from.row.regionId, cap.row.regionId)) return cap.row.regionId;
    }
    // Nearest region that outlasts this one by the safety margin; failing that, the one that lasts longest.
    const margin = from.hours + c.safeMarginDays * 24;
    const reachable = safe.filter((x) => x.row.regionId !== from.row.regionId).map((x) => ({ x, r: route(from.row.regionId, x.row.regionId) })).filter((o): o is { x: typeof o.x; r: NonNullable<typeof o.r> } => !!o.r);
    const lasting = reachable.filter((o) => o.x.hours >= margin).sort((u, v) => u.r.cost - v.r.cost);
    return lasting[0]?.x.row.regionId ?? reachable.sort((u, v) => v.x.hours - u.x.hours)[0]?.x.row.regionId ?? null;
  };

  // 2. Evacuate what freezes within the warning.
  for (const x of info) {
    if (x.hours > settings.warningHours) break;
    if (evacuated >= c.evacuatePerPass) break;
    if (x.row.evacuatedAt || skip.has(x.row.regionId)) continue;
    if (Math.floor(x.row.popWorkers + x.row.popOccupiers) < 1 && unitTotal(x.row.units) === 0) continue;
    const to = destinationFor(x);
    if (!to) {
      bump("noRoute");
      suggestions.push({ regionId: x.row.regionId, text: `${name(x.row.regionId)} freezes in ${Math.max(0, Math.round(x.hours))} h and no safe region of yours can be reached from it; its people will be lost unless you move them by hand.` });
      continue;
    }
    const err = await attempt(() => evacuateRegion(ctx, x.row.regionId, to));
    if (err) {
      bump("blocked");
      suggestions.push({ regionId: x.row.regionId, text: `Could not evacuate ${name(x.row.regionId)}: ${err}.` });
    } else {
      evacuated += 1;
      moved += Math.floor(x.row.popWorkers + x.row.popOccupiers);
      suggestions.push({ regionId: to, text: `Evacuated ${name(x.row.regionId)} to ${name(to)}, ${Math.max(0, Math.round(x.hours))} h before the ice: ${Math.floor(x.row.popWorkers + x.row.popOccupiers)} people and ${unitTotal(x.row.units)} units on the road, the stores following by hauler.` });
    }
  }

  // 3. The capital: its wagon is slow, so it leaves well before the warning.
  const cap = p.capitalRegionId ? info.find((x) => x.row.regionId === p.capitalRegionId) : undefined;
  if (settings.moveCapital && cap && cap.hours <= settings.capitalHours) {
    const [wagon] = await db
      .select({ target: armies.targetRegionId })
      .from(armies)
      .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "relocate"), eq(armies.status, "outbound")))
      .limit(1);
    if (wagon) suggestions.push({ regionId: wagon.target, text: `The capital wagon is on its way to ${name(wagon.target)}.` });
    else {
      // The most populous region that outlasts the capital and that the wagon reaches before the ice; failing that, the nearest.
      const margin = cap.hours + c.safeMarginDays * 24;
      const pick = safe
        .filter((x) => x.row.regionId !== cap.row.regionId)
        .map((x) => ({ x, r: route(cap.row.regionId, x.row.regionId) }))
        .filter((o): o is { x: typeof o.x; r: NonNullable<typeof o.r> } => !!o.r)
        .map((o) => ({ ...o, inTime: (travelSeconds(o.r, balance.capital.wagonSpeed, m.speed) * 1000) / hourMs < cap.hours }))
        .sort((u, v) => Number(v.inTime) - Number(u.inTime) || Number(v.x.hours >= margin) - Number(u.x.hours >= margin) || (u.inTime ? v.x.row.popWorkers - u.x.row.popWorkers : u.r.cost - v.r.cost))[0]?.x;
      if (!pick) {
        bump("noRoute");
        suggestions.push({ regionId: cap.row.regionId, text: `Your capital freezes in ${Math.max(0, Math.round(cap.hours))} h and no safe region of yours can be reached by wagon. Settle or take land on the warm side, or make your last stand.` });
      } else {
        const err = await attempt(() => relocateCapital(ctx, pick.row.regionId));
        if (err) {
          bump("blocked");
          suggestions.push({ regionId: cap.row.regionId, text: `Could not move the capital to ${name(pick.row.regionId)}: ${err}.` });
        } else {
          suggestions.push({ regionId: pick.row.regionId, text: `The capital wagon has left ${name(cap.row.regionId)} for ${name(pick.row.regionId)}, which ${pick.hours === Infinity ? "never freezes" : `freezes ${Math.round((pick.hours - cap.hours) / 24)} days later`}.` });
          await notify(db as unknown as Parameters<typeof notify>[0], m.id, p.id, "system", `Your Warden of the Thaw is moving the capital from ${name(cap.row.regionId)} to ${name(pick.row.regionId)} ahead of the ice`, { regionId: pick.row.regionId, advisor: "thaw" });
        }
      }
    }
  }

  // 4. Settle the warm side while regions are being lost: one colony on the road at a time.
  if (settings.settle && clock.length > 0 && safe.length > 0) {
    const [outbound] = await db
      .select({ target: armies.targetRegionId })
      .from(armies)
      .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "settle"), eq(armies.status, "outbound")))
      .limit(1);
    if (outbound) suggestions.push({ regionId: outbound.target, text: `Settlers are on their way to ${name(outbound.target)}.` });
    else {
      // Free land next to safe ground that stays unfrozen long enough to be worth it.
      const minDay = matchDay + c.settleMinDays;
      const ownedIds = new Set(owned.map((r) => r.regionId));
      const candidates = new Set<string>();
      for (const s of safe) for (const n of regionById(s.row.regionId)?.neighbors ?? []) if (!ownedIds.has(n)) candidates.add(n);
      const rows = candidates.size ? await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, [...candidates]))) : [];
      const byId = new Map(rows.map((r) => [r.regionId, r]));
      const free = [...candidates].filter((id) => {
        const r = regionById(id);
        if (!r) return false;
        const day = freezeDayForLatitude(Math.abs(r.lat));
        if (day !== null && day < minDay) return false;
        const row = byId.get(id);
        return !row || (!row.ownerPlayerId && !row.frozenAt && row.popWorkers + row.popSoldiers + row.popOccupiers < 1 && unitTotal(row.units) === 0);
      });
      // Settlers come from the safe region holding the most, else the most populous one; the colony is the nearest free land that lasts longest.
      const source = [...safe].sort((u, v) => (v.row.units.settler ?? 0) - (u.row.units.settler ?? 0) || v.row.popWorkers - u.row.popWorkers)[0]!;
      const target = free
        .map((id) => ({ id, r: route(source.row.regionId, id), day: freezeDayForLatitude(Math.abs(regionById(id)!.lat)) }))
        .filter((o) => o.r)
        .sort((u, v) => (v.day ?? 999) - (u.day ?? 999) || distanceKm(source.row.regionId, u.id) - distanceKm(source.row.regionId, v.id))[0];
      if (!target) suggestions.push({ regionId: source.row.regionId, text: `No free land on the warm side can be reached from ${name(source.row.regionId)}; take some from a neighbour, or hire the Military advisor to.` });
      else {
        const need = balance.settle.settlersRequired;
        const have = source.row.units.settler ?? 0;
        if (have >= need) {
          const err = await attempt(() => sendArmy(ctx, source.row.regionId, { mission: "settle", targetRegionId: target.id, units: { settler: need }, people: 0, cargo: {} }));
          if (err) {
            bump("blocked");
            suggestions.push({ regionId: target.id, text: `Could not settle ${name(target.id)} from ${name(source.row.regionId)}: ${err}.` });
          } else {
            settled += 1;
            suggestions.push({ regionId: target.id, text: `${need} settlers left ${name(source.row.regionId)} for ${name(target.id)}, which ${target.day === null ? "never freezes" : `freezes on day ${target.day}`}.` });
          }
        } else {
          const pending = await db
            .select({ qty: jobs.qty })
            .from(jobs)
            .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, p.id), eq(jobs.regionId, source.row.regionId), eq(jobs.kind, "train"), eq(jobs.refId, "settler"), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
          const training = pending.reduce((x, j) => x + (j.qty ?? 0), 0);
          const want = need - have - training;
          if (want > 0) {
            const n = Math.max(unitById.get("settler")?.minBatch ?? 1, want);
            const err = await attempt(() => queueTrain(ctx, source.row.regionId, "settler", n, { allowWait: true, maxOwed: c.maxOwed }));
            if (err) bump(/not enough|shipped/.test(err) ? "unaffordable" : /queue is full/.test(err) ? "queueFull" : "blocked");
            else {
              trained += n;
              suggestions.push({ regionId: source.row.regionId, text: `Training ${n} settlers at ${name(source.row.regionId)} for ${name(target.id)} on the warm side.` });
            }
          } else suggestions.push({ regionId: source.row.regionId, text: `Settlers are training at ${name(source.row.regionId)} for ${name(target.id)}.` });
        }
      }
    }
  }

  // The report: the clock first, then what was done.
  for (const line of clock.slice(0, 6)) suggestions.unshift({ regionId: line.regionId, text: line.text });
  const report: AdvisorReport = { at: now.toISOString(), queued: 0, moved, rebalanced: 0, trained, fortified: 0, exposed: [], evacuated, settled, clock, researched: 0, listed: 0, bought: 0, skipped, suggestions: suggestions.slice(0, 14) };
  await db.update(advisors).set({ lastPassAt: now, lastReport: report }).where(eq(advisors.id, a.id));
  await publisher.toPlayer(m.id, p.id, "advisor.report", { kind: a.kind, evacuated, settled, clock: clock.length });
  return report;
}
