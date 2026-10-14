import { and, eq, inArray } from "drizzle-orm";
import { allianceMembers } from "../db/schema.js";
import type { Tx } from "./regions.js";
import type { Db } from "../db/client.js";

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
