import { balance } from "@lastthaw/shared";
import { and, eq, gt, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fairplayFlags, matches, players, sessionSightings, sessions, transfers, playerActions } from "../db/schema.js";

/**
 * Multi-account detection. Flags pairs of accounts in the same match that
 * share an IP or device fingerprint, and pairs that pass resources between
 * each other. Flags are queued for a human; nothing is ever auto-banned.
 */
export async function detectMultiAccounts(db: Db): Promise<number> {
  const running = await db.select({ id: matches.id }).from(matches).where(inArray(matches.status, ["lobby", "running"]));
  let created = 0;
  for (const m of running) {
    const ps = await db
      .select({ playerId: players.id, userId: players.userId })
      .from(players)
      .where(and(eq(players.matchId, m.id), eq(players.isAi, false), isNotNull(players.userId)));
    const userIds = ps.map((p) => p.userId!).filter(Boolean);
    if (userIds.length < 2) continue;
    const since = new Date(Date.now() - 30 * 86400_000);

    // Shared IP / fingerprint among accounts in this match.
    for (const kind of ["ip", "fingerprint"] as const) {
      const col = kind === "ip" ? sessions.ip : sessions.fingerprint;
      const rows = await db
        .select({ key: col, userId: sessions.userId })
        .from(sessions)
        .where(and(inArray(sessions.userId, userIds), isNotNull(col), gt(sessions.createdAt, since)))
        .groupBy(col, sessions.userId);
      // Addresses seen during play, not only at login.
      if (kind === "ip") {
        const seen = await db
          .select({ key: sessionSightings.ip, userId: sessionSightings.userId })
          .from(sessionSightings)
          .where(and(inArray(sessionSightings.userId, userIds), gt(sessionSightings.hour, since)))
          .groupBy(sessionSightings.ip, sessionSightings.userId);
        rows.push(...seen);
      }
      const byKey = new Map<string, Set<string>>();
      for (const r of rows) {
        if (!r.key) continue;
        if (kind === "ip" && (r.key === "127.0.0.1" || r.key === "::1")) continue;
        byKey.set(r.key, (byKey.get(r.key) ?? new Set()).add(r.userId));
      }
      for (const [key, set] of byKey) {
        const list = [...set].sort();
        if (list.length < 2 || list.length > 8) continue; // very large groups are likely a campus/NAT, still flagged below threshold
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            created += await flag(db, list[i]!, list[j]!, m.id, `shared_${kind}`, kind === "fingerprint" ? 3 : 2, { [kind]: key });
          }
        }
      }
    }

    // Resource transfers between accounts (one-way generosity is the classic feeder pattern).
    const playerToUser = new Map(ps.map((p) => [p.playerId, p.userId!]));
    const flows = await db
      .select({ from: transfers.fromPlayerId, to: transfers.toPlayerId, total: sql<number>`sum(${transfers.amount})::float`, n: sql<number>`count(*)::int` })
      .from(transfers)
      .where(and(eq(transfers.matchId, m.id), isNotNull(transfers.fromPlayerId), isNotNull(transfers.toPlayerId), ne(transfers.fromPlayerId, transfers.toPlayerId)))
      .groupBy(transfers.fromPlayerId, transfers.toPlayerId);
    for (const f of flows) {
      const a = playerToUser.get(f.from!);
      const b = playerToUser.get(f.to!);
      if (!a || !b || a === b) continue;
      if (f.total < 1000 && f.n < 5) continue;
      const [x, y] = [a, b].sort();
      created += await flag(db, x!, y!, m.id, "resource_transfers", f.total > 5000 ? 3 : 1, { from: f.from, to: f.to, total: f.total, count: f.n });
    }
  }
  return created;
}

/**
 * Automation: a human whose commands come at a machine's rhythm. Over the last
 * day, for every player with enough commands to judge: how regular the gaps
 * between commands are (a hand is bursty, a loop is flat), and in how many of
 * the day's hours they acted (a hand sleeps). Each signal adds to a score; two
 * or more raise a flag with the figures as evidence, once per match and day.
 */
export async function detectAutomation(db: Db, now = new Date()): Promise<number> {
  const c = balance.fairplay;
  const since = new Date(now.getTime() - 24 * 3600_000);
  const rows = await db
    .select({ matchId: playerActions.matchId, userId: playerActions.userId, at: playerActions.at })
    .from(playerActions)
    .innerJoin(matches, eq(matches.id, playerActions.matchId))
    .where(and(gt(playerActions.at, since), eq(matches.status, "running")))
    .orderBy(playerActions.userId, playerActions.matchId, playerActions.at);
  const groups = new Map<string, { matchId: string; userId: string; ats: number[] }>();
  for (const r of rows) {
    const k = `${r.userId}:${r.matchId}`;
    const g = groups.get(k) ?? { matchId: r.matchId, userId: r.userId, ats: [] };
    g.ats.push(r.at.getTime());
    groups.set(k, g);
  }
  let flagged = 0;
  for (const g of groups.values()) {
    if (g.ats.length < c.automationMinActions) continue;
    const gaps = g.ats.slice(1).map((t, i) => (t - g.ats[i]!) / 1000).filter((s) => s > 0.5);
    if (gaps.length < 10) continue;
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    const cv = mean > 0 ? sd / mean : 0;
    const hours = new Set(g.ats.map((t) => Math.floor(t / 3600_000))).size;
    let score = 0;
    const why: string[] = [];
    if (cv < c.automationRegularity) {
      score += 2;
      why.push(`commands ${Math.round(mean)}s apart with ${Math.round(cv * 100)}% variation`);
    }
    if (hours >= c.automationActiveHours) {
      score += 2;
      why.push(`active in ${hours} of the last 24 hours`);
    }
    if (g.ats.length >= c.automationMinActions * 6) {
      score += 1;
      why.push(`${g.ats.length} commands in a day`);
    }
    if (score < 2) continue;
    flagged += await flag(db, g.userId, g.userId, g.matchId, `automation_${now.toISOString().slice(0, 10)}`, score, { actions: g.ats.length, meanGapSeconds: Math.round(mean), variation: Math.round(cv * 100) / 100, activeHours: hours, why });
  }
  return flagged;
}

/** Keep the command log to the scan window. */
export async function pruneActions(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - balance.fairplay.actionRetentionDays * 86400_000);
  const gone = await db.delete(playerActions).where(lt(playerActions.at, cutoff)).returning({ id: playerActions.id });
  return gone.length;
}

async function flag(db: Db, userA: string, userB: string, matchId: string, reason: string, score: number, evidence: unknown): Promise<number> {
  const res = await db
    .insert(fairplayFlags)
    .values({ userA, userB, matchId, reason, score, evidence: evidence as Record<string, unknown> })
    .onConflictDoNothing()
    .returning({ id: fairplayFlags.id });
  return res.length;
}
