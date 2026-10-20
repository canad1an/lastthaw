/**
 * The books. Every resource a player spends is written to the ledger by category (build, military, research, advisors,
 * market, tribute, refugees) per game day; refunds come off again. Every quarter game day the tick samples what the
 * empire gathers and mines per hour and what its people and soldiers eat. The Financials tab reads both.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { economyHistory, matchRegions, spendLedger } from "../db/schema.js";
import { matchDayAt, matchNow } from "./clock.js";
import { ownerTechEffects, projectRegion, resourceMultOf, type Tx } from "./regions.js";
import type { MatchRow } from "../worker/jobs.js";
import { balance, type TechEffects } from "@lastthaw/shared";

export type SpendCategory = "build" | "military" | "research" | "advisors" | "market" | "tribute" | "refugees";

/** Add `cost` (times `factor`, so a refund is -1) to the player's ledger for today's game day. */
export async function recordSpend(tx: Tx | Db, m: MatchRow, playerId: string, category: SpendCategory, cost: Record<string, number | undefined>, factor = 1): Promise<void> {
  const day = Math.floor(matchDayAt(m, matchNow(m)));
  for (const [resource, v] of Object.entries(cost)) {
    const amount = (v ?? 0) * factor;
    if (!amount || !Number.isFinite(amount)) continue;
    await tx
      .insert(spendLedger)
      .values({ matchId: m.id, playerId, day, category, resource, amount })
      .onConflictDoUpdate({ target: [spendLedger.matchId, spendLedger.playerId, spendLedger.day, spendLedger.category, spendLedger.resource], set: { amount: sql`${spendLedger.amount} + ${amount}` } });
  }
}

export interface EconomySample {
  /** Gathered and mined per game hour, before anything is eaten. */
  gross: Record<string, number>;
  /** Food eaten per game hour by people and by soldiers. */
  eaten: { people: number; soldiers: number };
  regions: number;
}

/** What a player's empire produces and eats right now, summed over its unfrozen regions. */
export async function economyNow(db: Tx | Db, m: MatchRow, playerId: string, now = matchNow(m), fx?: TechEffects): Promise<EconomySample> {
  const rows = await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, playerId), sql`${matchRegions.frozenAt} is null`));
  return sampleOf(rows, m, now, fx ?? (await ownerTechEffects(db, playerId)));
}

function sampleOf(rows: Array<typeof matchRegions.$inferSelect>, m: MatchRow, now: Date, fx: TechEffects): EconomySample {
  const gross: Record<string, number> = { food: 0, wood: 0, stone: 0 };
  const eaten = { people: 0, soldiers: 0 };
  const eco = balance.economy;
  for (const row of rows) {
    const { rates, economy } = projectRegion(row, now, m.speed, fx, resourceMultOf(m));
    for (const [k, v] of Object.entries(rates.gross)) gross[k] = (gross[k] ?? 0) + Math.max(0, v);
    for (const [k, v] of Object.entries(rates.special)) if (v > 0) gross[k] = (gross[k] ?? 0) + v;
    if (!economy.frozen && !economy.abandoned) {
      eaten.people += (economy.popWorkers + economy.popOccupiers) * eco.foodPerPersonPerHour;
      eaten.soldiers += economy.popSoldiers * eco.soldierFoodMultiplier * eco.foodPerPersonPerHour;
    }
  }
  return { gross, eaten, regions: rows.length };
}

/** One sample per quarter game day per player, written by the tick; nothing happens between samples. */
export async function recordEconomy(tx: Tx, m: MatchRow, now: Date): Promise<void> {
  if (!m.startsAt) return;
  // The quarter day that has begun, never one ahead of the clock.
  const day = Math.floor(matchDayAt(m, now) * 4) / 4;
  const [already] = await tx.select({ day: economyHistory.day }).from(economyHistory).where(and(eq(economyHistory.matchId, m.id), eq(economyHistory.day, day))).limit(1);
  if (already) return;
  const rows = await tx.select().from(matchRegions).where(and(eq(matchRegions.matchId, m.id), sql`${matchRegions.ownerPlayerId} is not null`, sql`${matchRegions.frozenAt} is null`));
  const byOwner = new Map<string, Array<typeof matchRegions.$inferSelect>>();
  for (const r of rows) byOwner.set(r.ownerPlayerId!, [...(byOwner.get(r.ownerPlayerId!) ?? []), r]);
  for (const [playerId, mine] of byOwner) {
    const s = sampleOf(mine, m, now, await ownerTechEffects(tx, playerId));
    await tx.insert(economyHistory).values({ matchId: m.id, playerId, day, gross: s.gross, eaten: s.eaten, regions: s.regions }).onConflictDoNothing();
  }
}
