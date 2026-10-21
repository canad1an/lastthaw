/**
 * Theo, the Chancellor. Every pass he fills the research queue toward the goal you set (the next age, hauling, walls
 * or the sea), in prerequisite order, honouring the day gates; then he works the market: stock near its cap is listed
 * at the fair price for what the empire owes or lacks, stale listings are withdrawn, and what waiting builds, training
 * and the next research owe is bought from the cheapest open offer that is not too far above fair, into the capital.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { balance, availableTechs, effectsOf, fairAmount, regionById, storageCaps, techById, techCost, TECHS, RESOURCE_WORTH, tradeResource, type AdvisorReport, type AdvisorSuggestion, type TradeResource } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { advisors, armies, jobs, marketOrders, matchRegions, players, playerTechs, tradeRoutes } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { acceptMarketOrder, cancelMarketOrder, createMarketOrder } from "../matches/marketApi.js";
import { matchDayAt } from "./clock.js";
import { queueResearch, type CommandContext } from "./commands.js";
import { stockOf, type MatchRegionRow } from "./regions.js";
import { parseSettings, type AdvisorRow } from "./advisors.js";
import type { MatchRow } from "../worker/jobs.js";

type PlayerRow = typeof players.$inferSelect;

const name = (id: string) => regionById(id)?.name ?? id;
const BASE = new Set(["food", "wood", "stone"]);

/** The tech a goal works toward: the next age's tech, the next step of the hauler ladder, or a fixed tech. */
export function goalTech(goal: string, age: number): string | null {
  if (goal === "age") return TECHS.find((t) => t.advancesTo === age + 1)?.id ?? null;
  if (goal === "hauling") {
    // The first fleet rebuild of this age or a later one; the last of the ladder once past them all.
    const ladder = Object.keys(balance.trade.fleetUpgradeTech).sort((a, b) => (techById.get(a)?.age ?? 0) - (techById.get(b)?.age ?? 0));
    return ladder.find((id) => (techById.get(id)?.age ?? 0) >= age) ?? ladder[ladder.length - 1] ?? null;
  }
  const fixed: Record<string, string> = { walls: "concrete", sea: "navigation" };
  return fixed[goal] ?? null;
}

/** The techs still to research on the way to `goal`, prerequisites first: the AI's walk, lifted. */
export function pathTo(goal: string, known: ReadonlySet<string>): string[] {
  const want: string[] = [];
  const walk = (id: string) => {
    if (known.has(id) || want.includes(id)) return;
    for (const r of techById.get(id)?.requires ?? []) walk(r);
    want.push(id);
  };
  walk(goal);
  return want;
}

/** Storage cap for one resource in a region: food, wood and stone by buildings; ore and horses by the special cap. */
function capFor(row: MatchRegionRow, res: string): number {
  if (res === "food" || res === "wood" || res === "stone") return storageCaps(effectsOf(row.buildings), row.isCapital)[res];
  return balance.economy.specialStorage;
}

/** One pass of the Chancellor: research toward the goal, then the market. */
export async function chancellorPass(db: Db, m: MatchRow, p: PlayerRow, a: AdvisorRow, now: Date, publisher: Publisher): Promise<AdvisorReport> {
  const c = balance.advisors.chancellor;
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
  const matchDay = matchDayAt(m, now);
  let researched = 0;
  let listed = 0;
  let bought = 0;

  const owned = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt)));
  const capital = owned.find((r) => r.regionId === p.capitalRegionId) ?? null;
  const pooled: Record<string, number> = {};
  for (const r of owned) for (const [k, v] of Object.entries(stockOf(r))) pooled[k] = (pooled[k] ?? 0) + v;
  const pending = await db
    .select({ kind: jobs.kind, refId: jobs.refId, regionId: jobs.regionId, waitingFor: jobs.waitingFor })
    .from(jobs)
    .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, p.id), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));

  // What the empire owes: every waiting build and training order, less what the materials routes hold and the convoys carry.
  const owed: Record<string, number> = {};
  for (const j of pending) if (j.waitingFor) for (const [k, v] of Object.entries(j.waitingFor as Record<string, number>)) owed[k] = (owed[k] ?? 0) + v;
  if (Object.keys(owed).length) {
    const routes = await db.select({ held: tradeRoutes.held }).from(tradeRoutes).where(and(eq(tradeRoutes.matchId, m.id), eq(tradeRoutes.playerId, p.id), sql`${tradeRoutes.forJobId} is not null`));
    for (const r of routes) for (const [k, v] of Object.entries(r.held)) owed[k] = (owed[k] ?? 0) - Math.max(0, v);
    const rolling = await db.select({ cargo: armies.cargo, stops: armies.stops }).from(armies).where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "transport"), eq(armies.status, "outbound")));
    for (const r of rolling) {
      for (const [k, v] of Object.entries(r.cargo)) if (k !== "people") owed[k] = (owed[k] ?? 0) - v;
      for (const s of r.stops) if (!s.done) for (const [k, v] of Object.entries(s.take)) owed[k] = (owed[k] ?? 0) - v;
    }
  }

  // 1. Research: the path to the goal, prerequisites first, a few techs a pass, leaving slots for you.
  const queuedTechs = new Set(pending.filter((j) => j.kind === "research").map((j) => j.refId ?? ""));
  const goal = settings.researchGoal === "off" ? null : goalTech(settings.researchGoal, p.age);
  if (goal && techs.has(goal)) suggestions.push({ regionId: null, text: `${techById.get(goal)?.name ?? goal} is yours: pick the next research goal.` });
  else if (goal) {
    const known = new Set([...techs, ...queuedTechs]);
    const avail = new Set(availableTechs(p.age, known).filter((t) => !queuedTechs.has(t.id)).map((t) => t.id));
    const path = pathTo(goal, known);
    let slots = balance.queue.researchSlots - c.keepSlotsFree - queuedTechs.size;
    let tries = 0;
    for (const id of path) {
      if (slots <= 0 || tries >= c.researchPerPass) break;
      const def = techById.get(id)!;
      if (!avail.has(id)) continue;
      if (def.earliestDay !== undefined && process.env.NO_AGE_DAYS !== "1" && matchDay < def.earliestDay) {
        suggestions.push({ regionId: null, text: `${def.name} can be researched from day ${def.earliestDay + 1}; the path waits on it.` });
        break;
      }
      tries += 1;
      const err = await attempt(() => queueResearch(ctx, id));
      if (!err) {
        researched += 1;
        slots -= 1;
        known.add(id);
        for (const t of availableTechs(p.age, known)) if (!known.has(t.id)) avail.add(t.id);
        suggestions.push({ regionId: null, text: `Queued ${def.name} on the way to ${techById.get(goal)?.name ?? goal}.` });
      } else if (/not enough/.test(err)) {
        bump("unaffordable");
        // What the next tech lacks joins the shopping list.
        const cost = techCost(def, matchDay);
        const short: string[] = [];
        for (const [k, v] of Object.entries(cost)) {
          const miss = (v ?? 0) - (pooled[k] ?? 0);
          if (miss > 0) {
            owed[k] = (owed[k] ?? 0) + miss;
            short.push(`${Math.ceil(miss)} ${k}`);
          }
        }
        suggestions.push({ regionId: null, text: `${def.name} waits on ${short.join(", ") || "stock"} across your regions; he is buying it where the market offers it.` });
        break;
      } else {
        bump("blocked");
        break;
      }
    }
  }

  // 2. The market, if there is a capital to trade from.
  const mine = await db.select().from(marketOrders).where(and(eq(marketOrders.matchId, m.id), eq(marketOrders.playerId, p.id), eq(marketOrders.status, "open")));
  if (capital) {
    // Stale listings come down; they are relisted at the next pass if the surplus is still there.
    if (settings.sell) {
      for (const o of mine) {
        if (now.getTime() - o.createdAt.getTime() < c.staleHours * hourMs) continue;
        const err = await attempt(() => cancelMarketOrder(db, m, p, o.id));
        if (!err) {
          o.status = "cancelled";
          suggestions.push({ regionId: o.regionId, text: `Withdrew the listing of ${o.offerAmount} ${o.offerResource} for ${o.askAmount} ${o.askResource} from ${name(o.regionId)}: ${c.staleHours} hours without a buyer.` });
        }
      }
    }
    const open = mine.filter((o) => o.status === "open");

    // Buying: what the empire owes, largest first, from the cheapest offer not too far above fair, paid from the capital with a reserve kept.
    if (settings.buy) {
      const offers = await db.select().from(marketOrders).where(and(eq(marketOrders.matchId, m.id), eq(marketOrders.status, "open"), ne(marketOrders.playerId, p.id)));
      const capStock = stockOf(capital);
      const wants = Object.entries(owed)
        .filter(([k, v]) => v >= 1 && tradeResource.safeParse(k).success)
        .sort((x, y) => y[1] * (RESOURCE_WORTH[y[0]] ?? 1) - x[1] * (RESOURCE_WORTH[x[0]] ?? 1));
      for (const [res, need] of wants) {
        if (bought >= c.buysPerPass) break;
        const candidates = offers
          .filter((o) => o.offerResource === res && o.status === "open")
          .map((o) => ({ o, price: (o.askAmount * (RESOURCE_WORTH[o.askResource] ?? 1)) / (o.offerAmount * (RESOURCE_WORTH[o.offerResource] ?? 1)) }))
          .filter(({ o, price }) => price <= settings.overpay && (capStock[o.askResource] ?? 0) - o.askAmount >= settings.reserveShare * capFor(capital, o.askResource))
          .sort((x, y) => x.price - y.price);
        const pick = candidates[0];
        if (!pick) {
          suggestions.push({ regionId: null, text: `Nothing on the market offers ${Math.ceil(need)} ${res} within ${Math.round((settings.overpay - 1) * 100)}% of fair, which your waiting orders need.` });
          continue;
        }
        const err = await attempt(() => acceptMarketOrder(db, m, p, pick.o.id, capital.regionId));
        if (err) bump("blocked");
        else {
          bought += 1;
          pick.o.status = "filled";
          capStock[pick.o.askResource] = (capStock[pick.o.askResource] ?? 0) - pick.o.askAmount;
          owed[res] = (owed[res] ?? 0) - pick.o.offerAmount;
          suggestions.push({ regionId: capital.regionId, text: `Bought ${pick.o.offerAmount} ${res} for ${pick.o.askAmount} ${pick.o.askResource} into ${name(capital.regionId)} (${Math.round(pick.price * 100)}% of fair).` });
        }
      }
    }

    // Selling: a store near its cap is listed at the fair price for what the empire owes or holds least.
    if (settings.sell) {
      const askFor = (give: string): TradeResource => {
        const wanted = Object.entries(owed).filter(([k, v]) => v >= 1 && k !== give && tradeResource.safeParse(k).success).sort((x, y) => y[1] - x[1])[0];
        if (wanted) return wanted[0] as TradeResource;
        const ores = (["iron", "copper", "tin", "horses"] as const).filter((k) => k !== give).sort((x, y) => (pooled[x] ?? 0) - (pooled[y] ?? 0));
        return ores[0]!;
      };
      for (const row of [...owned].sort((x, y) => Number(y.isCapital) - Number(x.isCapital))) {
        if (open.length >= settings.maxOrders) break;
        if (skip.has(row.regionId) || row.evacuatedAt) continue;
        const stock = stockOf(row) as Record<string, number>;
        for (const res of ["food", "wood", "stone"] as const) {
          if (open.length >= settings.maxOrders) break;
          const cap = capFor(row, res);
          const have = stock[res] ?? 0;
          if (have < settings.sellAbove * cap) continue;
          if (open.some((o) => o.regionId === row.regionId && o.offerResource === res)) continue;
          const amount = Math.floor(have - c.sellDownTo * cap);
          if (amount < c.minListing) continue;
          const ask = askFor(res);
          const askAmount = Math.max(1, fairAmount(res, amount, ask));
          const err = await attempt(async () => {
            const o = await createMarketOrder(db, m, p, { regionId: row.regionId, offerResource: res, offerAmount: amount, askResource: ask, askAmount });
            open.push(o);
          });
          if (err) bump(/open orders/.test(err) ? "ordersFull" : "blocked");
          else {
            listed += 1;
            suggestions.push({ regionId: row.regionId, text: `Listed ${amount.toLocaleString("en-US")} ${res} from ${name(row.regionId)} (${Math.round((have / cap) * 100)}% of its store) for ${askAmount.toLocaleString("en-US")} ${ask}.` });
          }
        }
      }
    }
  } else suggestions.push({ regionId: null, text: "No capital to trade from." });

  const report: AdvisorReport = { at: now.toISOString(), queued: 0, moved: 0, rebalanced: 0, trained: 0, fortified: 0, exposed: [], evacuated: 0, settled: 0, clock: [], researched, listed, bought, skipped, suggestions: suggestions.slice(0, 14) };
  await db.update(advisors).set({ lastPassAt: now, lastReport: report }).where(eq(advisors.id, a.id));
  await publisher.toPlayer(m.id, p.id, "advisor.report", { kind: a.kind, researched, listed, bought });
  return report;
}
