import { and, eq, inArray } from "drizzle-orm";
import { balance } from "@lastthaw/shared";
import { allianceInvites, allianceMembers, alliances, events, matchRegions, messages } from "../db/schema.js";
import type { Tx } from "./regions.js";
import type { Db } from "../db/client.js";
import type { Publisher } from "../realtime/publish.js";
import { matchDayAt, matchNow } from "./clock.js";
import type { MatchRow } from "../worker/jobs.js";

/** True when both players are in the same alliance. */
export async function areAllied(db: Tx | Db, matchId: string, a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const rows = await db
    .select({ playerId: allianceMembers.playerId, allianceId: allianceMembers.allianceId })
    .from(allianceMembers)
    .where(and(eq(allianceMembers.matchId, matchId), inArray(allianceMembers.playerId, [a, b])));
  if (rows.length < 2) return false;
  return rows[0]!.allianceId === rows[1]!.allianceId;
}

/** Ids of every player allied with `playerId` (excluding themselves). */
export async function alliesOf(db: Tx | Db, matchId: string, playerId: string): Promise<string[]> {
  const [mine] = await db
    .select({ allianceId: allianceMembers.allianceId })
    .from(allianceMembers)
    .where(and(eq(allianceMembers.matchId, matchId), eq(allianceMembers.playerId, playerId)))
    .limit(1);
  if (!mine) return [];
  const rows = await db.select({ playerId: allianceMembers.playerId }).from(allianceMembers).where(eq(allianceMembers.allianceId, mine.allianceId));
  return rows.map((r) => r.playerId).filter((id) => id !== playerId);
}

/**
 * Where a player's goods may be handed over between legs of a journey: their own regions and their allies'.
 * Pass the result to nextHopTo so a ship never tries to unload at a harbour nobody friendly holds.
 */
export async function landableFor(db: Tx | Db, matchId: string, playerId: string): Promise<(regionId: string) => boolean> {
  const owners = [playerId, ...(await alliesOf(db, matchId, playerId))];
  const rows = await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, matchId), inArray(matchRegions.ownerPlayerId, owners)));
  const ids = new Set(rows.map((r) => r.regionId));
  return (regionId) => ids.has(regionId);
}

/** Day shown to players (1-based) on which alliances dissolve: the morning after alliancesEndDay whole days have gone. */
export const ALLIANCES_END_DAY_SHOWN = balance.match.alliancesEndDay + 1;

/** False once alliancesEndDay whole days of the match have gone: nothing can be founded, offered or joined after that. */
export function alliancesOpen(m: MatchRow): boolean {
  return matchDayAt(m, matchNow(m)) < balance.match.alliancesEndDay;
}

/**
 * The end of alliances: every alliance in the match dissolves at once, every member is told, open invitations are
 * dropped, and the match hears of it. Returns how many alliances ended.
 */
export async function dissolveAlliances(tx: Tx, m: MatchRow, at: Date, publisher: Publisher | null, after: (fn: () => Promise<void>) => void): Promise<number> {
  const all = await tx.select().from(alliances).where(eq(alliances.matchId, m.id));
  for (const a of all) {
    const members = await tx.select({ playerId: allianceMembers.playerId }).from(allianceMembers).where(eq(allianceMembers.allianceId, a.id));
    for (const r of members) {
      await tx.insert(messages).values({ matchId: m.id, playerId: r.playerId, kind: "alliance", subject: `[${a.tag}] ${a.name} has dissolved: from day ${ALLIANCES_END_DAY_SHOWN} every tribe stands alone`, payload: { allianceId: a.id, dissolved: true, allianceEnd: true } });
    }
    await tx.delete(allianceMembers).where(eq(allianceMembers.allianceId, a.id));
    await tx.delete(alliances).where(eq(alliances.id, a.id));
  }
  await tx.delete(allianceInvites).where(eq(allianceInvites.matchId, m.id));
  if (all.length) {
    await tx.insert(events).values({ matchId: m.id, at, kind: "alliances.ended", payload: { count: all.length } });
    const ids = all.map((a) => a.id);
    if (publisher) after(() => Promise.all(ids.map((id) => publisher.toMatch(m.id, "alliance.updated", { allianceId: id, action: "dissolved" }))).then(() => undefined));
  }
  return all.length;
}
