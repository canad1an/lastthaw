import { and, eq, isNull, sql } from "drizzle-orm";
import { allRegions, balance } from "@lastthaw/shared";
import { allianceMembers, alliances, events, jobs, matchRegions, matches, players, userMatchResults } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import type { Tx } from "./regions.js";
import type { JobRow, MatchRow } from "../worker/jobs.js";
import { notify } from "../worker/jobs.js";

/** Score for one player from territory, population and age. */
export function scoreOf(regions: number, population: number, age: number): number {
  const w = balance.win.scoreWeights;
  return Math.round(regions * w.territory + population * w.population + age * w.age);
}

/** Recompute every player's score from current state. */
export async function updateScores(tx: Tx, m: MatchRow): Promise<Array<{ id: string; score: number; regions: number }>> {
  const rows = await tx
    .select({
      owner: matchRegions.ownerPlayerId,
      regions: sql<number>`count(*)::int`,
      pop: sql<number>`coalesce(sum(${matchRegions.popWorkers} + ${matchRegions.popSoldiers} + ${matchRegions.popOccupiers}), 0)::float`,
    })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), sql`${matchRegions.ownerPlayerId} is not null`, isNull(matchRegions.frozenAt)))
    .groupBy(matchRegions.ownerPlayerId);
  const byOwner = new Map(rows.map((r) => [r.owner!, r]));
  const ps = await tx.select({ id: players.id, age: players.age }).from(players).where(eq(players.matchId, m.id));
  const out: Array<{ id: string; score: number; regions: number }> = [];
  for (const p of ps) {
    const r = byOwner.get(p.id);
    const score = scoreOf(r?.regions ?? 0, r?.pop ?? 0, p.age);
    await tx.update(players).set({ score }).where(eq(players.id, p.id));
    out.push({ id: p.id, score, regions: r?.regions ?? 0 });
  }
  return out;
}

/**
 * Early win: a player or alliance holding 60 % of all regions starts a
 * 48-hour hold job; losing the share cancels it; the job expiring ends the match.
 */
export async function checkEarlyWin(tx: Tx, m: MatchRow, at: Date, standings: Array<{ id: string; regions: number }>, publisher: Publisher, after: (fn: () => Promise<void>) => void): Promise<void> {
  const total = allRegions().length;
  const needed = Math.ceil(total * balance.win.regionShareForEarlyWin);
  const members = await tx
    .select({ playerId: allianceMembers.playerId, allianceId: allianceMembers.allianceId })
    .from(allianceMembers)
    .where(eq(allianceMembers.matchId, m.id));
  const allianceOf = new Map(members.map((x) => [x.playerId, x.allianceId]));
  const byAlliance = new Map<string, number>();
  let leader: { kind: "player" | "alliance"; id: string; regions: number } | null = null;
  for (const s of standings) {
    if (s.regions >= needed && (!leader || s.regions > leader.regions)) leader = { kind: "player", id: s.id, regions: s.regions };
    const a = allianceOf.get(s.id);
    if (a) byAlliance.set(a, (byAlliance.get(a) ?? 0) + s.regions);
  }
  for (const [id, regions] of byAlliance) {
    if (regions >= needed && (!leader || regions > leader.regions)) leader = { kind: "alliance", id, regions };
  }

  const [pending] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.matchId, m.id), eq(jobs.kind, "win_hold"), isNull(jobs.completedAt), isNull(jobs.cancelledAt)))
    .limit(1);
  const pendingFor = pending ? (pending.payload as { kind?: string; id?: string }) : null;

  if (leader && (!pendingFor || pendingFor.id !== leader.id)) {
    if (pending) await tx.update(jobs).set({ cancelledAt: at }).where(eq(jobs.id, pending.id));
    const endsAt = new Date(at.getTime() + (balance.win.holdHours * 3600 * 1000) / m.speed);
    let winnerPlayerId = leader.id;
    let name = "";
    if (leader.kind === "alliance") {
      const [a] = await tx.select().from(alliances).where(eq(alliances.id, leader.id)).limit(1);
      winnerPlayerId = a?.leaderPlayerId ?? leader.id;
      name = a ? `the ${a.name} alliance` : "an alliance";
    } else {
      const [p] = await tx.select({ name: players.name }).from(players).where(eq(players.id, leader.id)).limit(1);
      name = p?.name ?? "a player";
    }
    await tx.insert(jobs).values({ matchId: m.id, kind: "win_hold", payload: { kind: leader.kind, id: leader.id, playerId: winnerPlayerId }, startsAt: at, endsAt });
    await tx.insert(events).values({ matchId: m.id, at, kind: "win.hold.started", payload: { ...leader, endsAt } });
    const everyone = await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, m.id), eq(players.isAi, false)));
    for (const p of everyone) await notify(tx, m.id, p.id, "system", `${name} holds ${leader.regions} regions. The match ends in ${balance.win.holdHours} hours unless they are pushed back.`, { endsAt });
    after(() => publisher.toMatch(m.id, "match.started", { winHold: true }));
  } else if (!leader && pending) {
    await tx.update(jobs).set({ cancelledAt: at }).where(eq(jobs.id, pending.id));
    await tx.insert(events).values({ matchId: m.id, at, kind: "win.hold.cancelled", payload: {} });
  }
}

/** Mark the match finished, rank everyone and record their history. */
export async function finishMatch(tx: Tx, m: MatchRow, at: Date, publisher: Publisher, after: (fn: () => Promise<void>) => void, winnerPlayerId: string | null): Promise<void> {
  if (m.status !== "running") return;
  const standings = await updateScores(tx, m);
  const ps = await tx.select().from(players).where(eq(players.matchId, m.id));
  const ranked = [...ps].sort((a, b) => (standings.find((s) => s.id === b.id)?.score ?? 0) - (standings.find((s) => s.id === a.id)?.score ?? 0));
  const winner = winnerPlayerId ?? ranked[0]?.id ?? null;
  await tx.update(matches).set({ status: "finished", finishedAt: at, winnerPlayerId: winner }).where(eq(matches.id, m.id));
  for (let i = 0; i < ranked.length; i++) {
    const p = ranked[i]!;
    if (!p.userId) continue;
    const s = standings.find((x) => x.id === p.id);
    await tx
      .insert(userMatchResults)
      .values({ userId: p.userId, matchId: m.id, playerId: p.id, finalRank: i + 1, score: s?.score ?? 0, regionsHeld: s?.regions ?? 0, ageReached: p.age, eliminatedAt: p.eliminatedAt, won: p.id === winner })
      .onConflictDoNothing();
    await notify(tx, m.id, p.id, "system", `The match is over. You finished #${i + 1}${p.id === winner ? " and won!" : "."}`, { rank: i + 1, winner });
  }
  await tx.insert(events).values({ matchId: m.id, at, kind: "match.finished", payload: { winnerPlayerId: winner } });
  after(() => publisher.toMatch(m.id, "match.finished", { winnerPlayerId: winner }));
}

export async function winHoldExpired(tx: Tx, m: MatchRow, job: JobRow, publisher: Publisher, after: (fn: () => Promise<void>) => void): Promise<void> {
  const winner = (job.payload as { playerId?: string }).playerId ?? null;
  await finishMatch(tx, m, job.endsAt, publisher, after, winner);
}
