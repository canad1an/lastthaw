import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { balance, regionById } from "@lastthaw/shared";
import { battles, bounties, dailyObjectives, events, matchRegions, playerTechs, players } from "../db/schema.js";
import { awardMilestone } from "./endgame.js";
import { settleAndLockRegion, type Tx } from "./regions.js";
import { notify, type MatchRow } from "../worker/jobs.js";

export const OBJECTIVES: Record<string, string> = {
  regions: "Most regions held at day's end",
  people: "Most people at day's end",
  food: "Largest food stock at day's end",
  coastal: "Most coastal regions at day's end",
  techs: "Most techs finished in the day",
  battles_won: "Most battles won in the day",
};

const dayMs = (m: MatchRow) => 86400_000 / m.speed;

/** Choose the day's objective and announce it. */
export async function pickObjective(tx: Tx, m: MatchRow, day: number, rng: () => number): Promise<void> {
  const keys = objectiveKeysFor(day);
  const key = keys[Math.floor(rng() * keys.length)]!;
  await tx.insert(dailyObjectives).values({ matchId: m.id, day, key }).onConflictDoNothing();
}

/** The objectives a day may draw: late in the match nobody finishes a tech in a day, so that one retires. */
export function objectiveKeysFor(day: number): string[] {
  return Object.keys(OBJECTIVES).filter((k) => k !== "techs" || day < balance.events.objective.techsUntilDay);
}

/** Settle yesterday's objective: find the best player, give them the daily bonus, tell everyone. */
export async function resolveObjective(tx: Tx, m: MatchRow, day: number, now: Date): Promise<void> {
  const [row] = await tx.select().from(dailyObjectives).where(and(eq(dailyObjectives.matchId, m.id), eq(dailyObjectives.day, day))).limit(1);
  if (!row || row.winnerPlayerId) return;
  const start = new Date(m.startsAt.getTime() + day * dayMs(m));
  const end = new Date(start.getTime() + dayMs(m));
  const eligible = new Set((await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, m.id), eq(players.hidden, false), isNull(players.eliminatedAt)))).map((p) => p.id));
  let scores: Array<{ playerId: string; value: number }> = [];
  if (row.key === "regions" || row.key === "people" || row.key === "food" || row.key === "coastal") {
    const rows = await tx
      .select({ owner: matchRegions.ownerPlayerId, regionId: matchRegions.regionId, pop: sql<number>`${matchRegions.popWorkers} + ${matchRegions.popSoldiers} + ${matchRegions.popOccupiers}`, food: matchRegions.food })
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), isNotNull(matchRegions.ownerPlayerId), isNull(matchRegions.frozenAt)));
    const by = new Map<string, number>();
    for (const r of rows) {
      const v = row.key === "regions" ? 1 : row.key === "people" ? Number(r.pop) : row.key === "food" ? r.food : regionById(r.regionId)?.coastal ? 1 : 0;
      by.set(r.owner!, (by.get(r.owner!) ?? 0) + v);
    }
    scores = [...by.entries()].map(([playerId, value]) => ({ playerId, value }));
  } else if (row.key === "techs") {
    const rows = await tx
      .select({ playerId: playerTechs.playerId, n: sql<number>`count(*)::int` })
      .from(playerTechs)
      .where(and(eq(playerTechs.matchId, m.id), gte(playerTechs.completedAt, start), lt(playerTechs.completedAt, end)))
      .groupBy(playerTechs.playerId);
    scores = rows.map((r) => ({ playerId: r.playerId, value: r.n }));
  } else if (row.key === "battles_won") {
    const rows = await tx
      .select({ playerId: battles.attackerPlayerId, n: sql<number>`count(*) filter (where (${battles.report}->>'attackerWon')::boolean)::int` })
      .from(battles)
      .where(and(eq(battles.matchId, m.id), gte(battles.resolvedAt, start), lt(battles.resolvedAt, end), isNotNull(battles.attackerPlayerId)))
      .groupBy(battles.attackerPlayerId);
    scores = rows.map((r) => ({ playerId: r.playerId!, value: r.n }));
  }
  const standings = await tx.select({ id: players.id, score: players.score }).from(players).where(and(eq(players.matchId, m.id), inArray(players.id, [...eligible])));
  const leaderId = [...standings].sort((a, b) => b.score - a.score)[0]?.id ?? null;
  const best = objectiveWinner(scores.filter((s) => eligible.has(s.playerId)), leaderId, balance.events.objective.leaderHandicap);
  if (!best) {
    await tx.update(dailyObjectives).set({ value: 0 }).where(and(eq(dailyObjectives.matchId, m.id), eq(dailyObjectives.day, day)));
    return;
  }
  await tx.update(dailyObjectives).set({ winnerPlayerId: best.playerId, value: Math.round(best.value) }).where(and(eq(dailyObjectives.matchId, m.id), eq(dailyObjectives.day, day)));
  await awardMilestone(tx, m, `day_${day}`, best.playerId, now, `Day ${day}: ${OBJECTIVES[row.key] ?? row.key}`);
  await tx.insert(events).values({ matchId: m.id, at: now, kind: "objective.won", payload: { day, key: row.key, label: OBJECTIVES[row.key] ?? row.key, playerId: best.playerId, value: Math.round(best.value) } });
}

/**
 * The match is over: settle every objective still waiting on its day's end,
 * so the final day's prize is awarded instead of silently lapsing.
 */
export async function resolvePendingObjectives(tx: Tx, m: MatchRow, now: Date): Promise<void> {
  const open = await tx
    .select({ day: dailyObjectives.day })
    .from(dailyObjectives)
    .where(and(eq(dailyObjectives.matchId, m.id), isNull(dailyObjectives.winnerPlayerId), isNull(dailyObjectives.value)))
    .orderBy(dailyObjectives.day);
  for (const o of open) await resolveObjective(tx, m, o.day, now);
}

/**
 * The best value takes the day, but the match's score leader competes at a
 * handicap so the daily prize spreads around instead of snowballing.
 */
export function objectiveWinner(scores: Array<{ playerId: string; value: number }>, leaderId: string | null, handicap: number): { playerId: string; value: number } | undefined {
  const weighted = scores.filter((s) => s.value > 0).map((s) => ({ ...s, weighted: s.playerId === leaderId ? s.value * handicap : s.value }));
  return weighted.sort((a, b) => b.weighted - a.weighted || b.value - a.value)[0];
}

// ---------------------------------------------------------------- bounties

/** Put a price on a region or a player's head; whoever beats them in battle collects at their capital. */
export async function placeBounty(tx: Tx, m: MatchRow, b: { kind: "region" | "player"; regionId?: string; playerId?: string; amount: Record<string, number>; reason: string; hours?: number; grow?: number }, at: Date): Promise<void> {
  const total = Object.values(b.amount).reduce((a, v) => a + v, 0);
  if (total < 1) return;
  // With `grow`, a second bounty for the same reason on the same head raises the open one instead of stacking a new row beside it.
  if (b.grow) {
    const [open] = await tx
      .select()
      .from(bounties)
      .where(and(eq(bounties.matchId, m.id), eq(bounties.kind, b.kind), isNull(bounties.claimedBy), eq(bounties.reason, b.reason), b.regionId ? eq(bounties.regionId, b.regionId) : eq(bounties.playerId, b.playerId!), sql`(${bounties.expiresAt} is null or ${bounties.expiresAt} > ${at.toISOString()}::timestamptz)`))
      .limit(1);
    if (open) {
      const amount = Object.fromEntries(Object.entries(open.amount as Record<string, number>).map(([k, v]) => [k, Math.round(v * b.grow!)]));
      await tx.update(bounties).set({ amount }).where(eq(bounties.id, open.id));
      await tx.insert(events).values({ matchId: m.id, at, kind: "bounty.placed", payload: { regionId: b.regionId ?? null, playerId: b.playerId ?? null, reason: b.reason, amount, grown: true } });
      return;
    }
  }
  const expiresAt = b.hours ? new Date(at.getTime() + (b.hours * 3600_000) / m.speed) : null;
  await tx.insert(bounties).values({ matchId: m.id, kind: b.kind, regionId: b.regionId ?? null, playerId: b.playerId ?? null, amount: b.amount, reason: b.reason, expiresAt });
  await tx.insert(events).values({ matchId: m.id, at, kind: "bounty.placed", payload: { regionId: b.regionId ?? null, playerId: b.playerId ?? null, reason: b.reason, amount: b.amount } });
}

/** After a won battle: any open bounty on that region or its owner goes to the attacker's capital. */
export async function claimBounties(tx: Tx, m: MatchRow, attackerId: string, regionId: string, defenderId: string | null, at: Date): Promise<number> {
  const open = await tx
    .select()
    .from(bounties)
    .where(and(eq(bounties.matchId, m.id), isNull(bounties.claimedBy), sql`(${bounties.expiresAt} is null or ${bounties.expiresAt} > ${at.toISOString()}::timestamptz)`, sql`(${bounties.regionId} = ${regionId} or (${bounties.playerId} is not null and ${bounties.playerId} = ${defenderId ?? "00000000-0000-0000-0000-000000000000"}::uuid))`))
    .for("update");
  if (open.length === 0) return 0;
  const [p] = await tx.select({ capital: players.capitalRegionId, hidden: players.hidden }).from(players).where(eq(players.id, attackerId)).limit(1);
  if (!p || p.hidden) return 0;
  let claimed = 0;
  for (const b of open) {
    await tx.update(bounties).set({ claimedBy: attackerId, claimedAt: at }).where(eq(bounties.id, b.id));
    if (p?.capital) {
      const cap = await settleAndLockRegion(tx, m.id, p.capital, at, m.speed);
      if (cap.ownerPlayerId === attackerId) {
        const amount = b.amount as Record<string, number>;
        const special = { ...(cap.special as Record<string, number>) };
        const set: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(amount)) {
          if (k === "food" || k === "wood" || k === "stone") set[k] = cap[k] + v;
          else special[k] = (special[k] ?? 0) + v;
        }
        set.special = special;
        await tx.update(matchRegions).set(set).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, cap.regionId)));
      }
    }
    claimed += 1;
    const what = Object.entries(b.amount as Record<string, number>).map(([k, v]) => `${Math.round(v)} ${k}`).join(", ");
    await notify(tx, m.id, attackerId, "battle", `Bounty claimed (${b.reason}): ${what} delivered to your capital.`, { bounty: b.id, regionId });
    await tx.insert(events).values({ matchId: m.id, at, kind: "bounty.claimed", payload: { by: attackerId, regionId: b.regionId, playerId: b.playerId, reason: b.reason } });
  }
  return claimed;
}
