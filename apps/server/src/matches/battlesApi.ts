import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { regionById, type BattleDetailView, type LiveBattleView } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { battles, matches, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import { httpError } from "../sim/commands.js";
import { idParams } from "./params.js";
import { alliesOf } from "../sim/alliances.js";
import { z } from "zod";
import type { BattleLive, BattleOutcome } from "../sim/missions.js";

const battleParams = idParams.extend({ battleId: z.string().uuid() });
type BattleRow = typeof battles.$inferSelect;

/** The list entry for a battle, as the match state carries it for everyone in the match. */
export function liveBattleOf(b: BattleRow, names: Map<string, string>): LiveBattleView {
  const live = (b.live ?? null) as BattleLive | null;
  const outcome = (b.outcome ?? null) as BattleOutcome | null;
  const report = (b.report ?? {}) as { attackerWon?: boolean; conquered?: boolean };
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
    attackerWon: b.status === "fighting" ? null : (report.attackerWon ?? outcome?.result.attackerWon ?? null),
    conquered: b.status === "fighting" ? false : (report.conquered ?? false),
  };
}

/**
 * Battles: a player sees their own fights and their allies', nobody else's; an admin who is not in the match sees them
 * all. The list is the fights in progress, or with ?all=1 every such battle of the match, newest first: a battle is
 * kept for the whole match and its window replays it at any time.
 */
export async function battleRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  /** The player ids whose battles this user may see, or null for everyone's (an admin outside the match). */
  async function sideOf(matchId: string, userId: string, isAdmin: boolean): Promise<Set<string> | null> {
    const [m] = await db.select({ id: matches.id }).from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    const [p] = await db.select({ id: players.id }).from(players).where(and(eq(players.matchId, matchId), eq(players.userId, userId))).limit(1);
    if (!p) {
      if (isAdmin) return null;
      throw httpError(403, "not a player in this match");
    }
    return new Set([p.id, ...(await alliesOf(db, matchId, p.id))]);
  }
  const onSide = (side: Set<string> | null, b: BattleRow) => !side || (!!b.attackerPlayerId && side.has(b.attackerPlayerId)) || (!!b.defenderPlayerId && side.has(b.defenderPlayerId));

  app.get("/api/matches/:id/battles", async (req): Promise<LiveBattleView[]> => {
    const user = requireUser(req);
    const matchId = idParams.parse(req.params).id;
    const side = await sideOf(matchId, user.id, user.isAdmin);
    const all = (req.query as { all?: string } | undefined)?.all === "1";
    const rows = all
      ? await db.select().from(battles).where(and(eq(battles.matchId, matchId), isNotNull(battles.live))).orderBy(desc(sql`coalesce(${battles.startedAt}, ${battles.resolvedAt})`)).limit(300)
      : await db.select().from(battles).where(and(eq(battles.matchId, matchId), eq(battles.status, "fighting"))).orderBy(desc(battles.startedAt));
    const names = new Map((await db.select({ id: players.id, name: players.name }).from(players).where(eq(players.matchId, matchId))).map((p) => [p.id, p.name]));
    return rows.filter((b) => onSide(side, b)).map((b) => liveBattleOf(b, names));
  });

  app.get("/api/matches/:id/battles/:battleId", async (req): Promise<BattleDetailView> => {
    const user = requireUser(req);
    const { id: matchId, battleId } = battleParams.parse(req.params);
    const side = await sideOf(matchId, user.id, user.isAdmin);
    const [b] = await db.select().from(battles).where(and(eq(battles.matchId, matchId), eq(battles.id, battleId))).limit(1);
    if (!b || !b.live) throw httpError(404, "battle not found");
    if (!onSide(side, b)) throw httpError(403, "not your battle: only your own fights and your allies' can be watched");
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
