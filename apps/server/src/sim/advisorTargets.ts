import { and, eq, isNull } from "drizzle-orm";
import { advisorSettings } from "@lastthaw/shared";
import { advisors } from "../db/schema.js";
import type { Tx } from "./regions.js";

/**
 * A region that has become the player's is no longer something to take: drop it from the Military
 * advisor's target list, however it was won (by hand, by his campaign, settled, or inherited with a
 * beaten player's realm), so the red ⚔ leaves the map at once. No-op without a hired Military advisor.
 */
export async function clearMilitaryTargets(tx: Tx, matchId: string, playerId: string, regionIds: readonly string[]): Promise<void> {
  if (regionIds.length === 0) return;
  const [a] = await tx
    .select({ id: advisors.id, settings: advisors.settings })
    .from(advisors)
    .where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, playerId), eq(advisors.kind, "military"), isNull(advisors.firedAt)))
    .limit(1);
  if (!a) return;
  const settings = advisorSettings.parse(a.settings ?? {});
  const gone = new Set(regionIds);
  const targets = settings.targets.filter((t) => !gone.has(t));
  if (targets.length === settings.targets.length) return;
  await tx.update(advisors).set({ settings: { ...settings, targets } }).where(eq(advisors.id, a.id));
}
