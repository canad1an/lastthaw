import { and, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fairplayFlags, matches, players, sessions, transfers } from "../db/schema.js";

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

async function flag(db: Db, userA: string, userB: string, matchId: string, reason: string, score: number, evidence: unknown): Promise<number> {
  const res = await db
    .insert(fairplayFlags)
    .values({ userA, userB, matchId, reason, score, evidence: evidence as Record<string, unknown> })
    .onConflictDoNothing()
    .returning({ id: fairplayFlags.id });
  return res.length;
}
