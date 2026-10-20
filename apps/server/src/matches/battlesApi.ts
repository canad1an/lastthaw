import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { regionById, type BattleDetailView, type LiveBattleView } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { battles, matches, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import { httpError } from "../sim/commands.js";
import { idParams } from "./params.js";
import { z } from "zod";
import type { BattleLive, BattleOutcome } from "../sim/missions.js";

const battleParams = idParams.extend({ battleId: z.string().uuid() });
type BattleRow = typeof battles.$inferSelect;

/** The list entry for a battle, as the match state carries it for everyone in the match. */
export function liveBattleOf(b: BattleRow, names: Map<string, string>): LiveBattleView {
  const live = (b.live ?? null) as BattleLive | null;
  return {
    id: b.id,
    regionId: b.regionId,
    mission: live?.mission ?? "raid",
    attackerPlayerId: b.attackerPlayerId ?? "",
    attackerName: live?.attacker.name ?? names.get(b.attackerPlayerId ?? "") ?? "Unknown",
    defenderPlayerId: b.defenderPlayerId ?? null,
    defenderName: live?.defender.name ?? (b.defenderPlayerId ? (names.get(b.defenderPlayerId) ?? "Unknown") : "Neutral tribes"),
    round: b.round,
    totalRounds: b.totalRounds,
    nextRoundAt: b.nextRoundAt?.toISOString() ?? null,
    startedAt: (b.startedAt ?? b.resolvedAt).toISOString(),
    status: b.status === "fighting" ? "fighting" : "done",
  };
}

/** Battles in progress and just finished: anyone in the match (or an admin) may watch; the icon is on the shared map anyway. */
export async function battleRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  async function allowed(matchId: string, userId: string, isAdmin: boolean) {
    const [m] = await db.select({ id: matches.id }).from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    if (isAdmin) return;
    const [p] = await db.select({ id: players.id }).from(players).where(and(eq(players.matchId, matchId), eq(players.userId, userId))).limit(1);
    if (!p) throw httpError(403, "not a player in this match");
  }

  app.get("/api/matches/:id/battles", async (req): Promise<LiveBattleView[]> => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    await allowed(matchId, user.id, user.isAdmin);
    const rows = await db.select().from(battles).where(and(eq(battles.matchId, matchId), eq(battles.status, "fighting"))).orderBy(desc(battles.startedAt));
    const names = new Map((await db.select({ id: players.id, name: players.name }).from(players).where(eq(players.matchId, matchId))).map((p) => [p.id, p.name]));
    return rows.map((b) => liveBattleOf(b, names));
  });

  app.get("/api/matches/:id/battles/:battleId", async (req): Promise<BattleDetailView> => {
    const user = requireUser(req);
    const { id: matchId, battleId } = battleParams.parse(req.params);
    await allowed(matchId, user.id, user.isAdmin);
    const [b] = await db.select().from(battles).where(and(eq(battles.matchId, matchId), eq(battles.id, battleId))).limit(1);
    if (!b || !b.live) throw httpError(404, "battle not found");
    const names = new Map((await db.select({ id: players.id, name: players.name }).from(players).where(eq(players.matchId, matchId))).map((p) => [p.id, p.name]));
    const live = b.live as BattleLive;
    const outcome = (b.outcome ?? null) as BattleOutcome | null;
    const report = (b.report ?? {}) as { attackerWon?: boolean; conquered?: boolean; loot?: Record<string, number> };
    return {
      ...liveBattleOf(b, names),
      regionName: regionById(b.regionId)?.name ?? b.regionId,
      attacker: live.attacker,
      defender: live.defender,
      bonus: live.bonus,
      log: live.log.slice(-60),
      result: b.status === "fighting" ? null : { attackerWon: report.attackerWon ?? outcome?.result.attackerWon ?? false, conquered: report.conquered ?? false, loot: report.loot ?? {} },
    };
  });
}
