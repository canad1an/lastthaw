import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { AGES, balance, iceLatitudeOnDay, regionById } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { battles, events, matches, playerTechs, players, scoreHistory } from "../db/schema.js";
import { isTournament } from "./registrations.js";

export interface MatchStory {
  /** A few sentences on how the match went, written from the record. Empty while the match runs. */
  paragraphs: string[];
  /** One line on how it was won. */
  howWon: string;
  leadChanges: Array<{ day: number; playerId: string; playerName: string }>;
  biggestBattle: { day: number; regionName: string; attackerName: string; defenderName: string; losses: number; attackerWon: boolean; conquered: boolean } | null;
  iceLatitude: number;
  eliminated: number;
  counts: Record<string, number>;
  prev: { slug: string; name: string } | null;
  next: { slug: string; name: string } | null;
}

export interface PlayerArc {
  peakRank: number | null;
  battles: number;
  battlesWon: number;
  conquests: number;
  techs: number;
}

type MatchRow = typeof matches.$inferSelect;
type PlayerRow = typeof players.$inferSelect;

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const ageName = (age: number) => AGES[Math.max(0, Math.min(AGES.length - 1, age))] ?? "Stone";

/** How a match was won, in one line. */
export function howWonLine(winKind: string | null, winnerName: string, wonderName: string, population: number, regions: number): string {
  switch (winKind) {
    case "wonder":
      return `${winnerName} won by raising the ${wonderName}, the wonder that ends a match the moment it is finished.`;
    case "hold":
      return `${winnerName} won by holding ${Math.round(balance.win.regionShareForEarlyWin * 100)}% of the map for ${balance.win.holdHours} hours.`;
    case "score":
      return `${winnerName} won on score when the ice stopped.`;
    default:
      return `${winnerName} won by survival: ${fmt(population)} people alive in unfrozen land across ${regions} regions when the ice stopped on day ${balance.match.lengthDays}.`;
  }
}

/** Every player's arc through the match: best rank held, battles, conquests, techs. */
export async function playerArcs(db: Db, matchId: string, ps: PlayerRow[]): Promise<Map<string, PlayerArc>> {
  const arcs = new Map<string, PlayerArc>();
  for (const p of ps) arcs.set(p.id, { peakRank: null, battles: 0, battlesWon: 0, conquests: 0, techs: 0 });
  const hist = await db.select({ playerId: scoreHistory.playerId, day: scoreHistory.day, score: scoreHistory.score }).from(scoreHistory).where(eq(scoreHistory.matchId, matchId));
  const byDay = new Map<number, Array<{ playerId: string; score: number }>>();
  for (const h of hist) (byDay.get(h.day) ?? byDay.set(h.day, []).get(h.day)!).push({ playerId: h.playerId, score: h.score });
  for (const rows of byDay.values()) {
    rows.sort((a, b) => b.score - a.score);
    rows.forEach((r, i) => {
      const a = arcs.get(r.playerId);
      if (a && (a.peakRank === null || i + 1 < a.peakRank)) a.peakRank = i + 1;
    });
  }
  const fights = await db.select({ attacker: battles.attackerPlayerId, defender: battles.defenderPlayerId, report: battles.report }).from(battles).where(eq(battles.matchId, matchId));
  for (const f of fights) {
    const r = f.report as { attackerWon?: boolean; conquered?: boolean };
    const a = f.attacker ? arcs.get(f.attacker) : undefined;
    const d = f.defender ? arcs.get(f.defender) : undefined;
    if (a) {
      a.battles += 1;
      if (r.attackerWon) a.battlesWon += 1;
      if (r.conquered) a.conquests += 1;
    }
    if (d) {
      d.battles += 1;
      if (!r.attackerWon) d.battlesWon += 1;
    }
  }
  const techs = await db.select({ playerId: playerTechs.playerId, n: sql<number>`count(*)::int` }).from(playerTechs).where(eq(playerTechs.matchId, matchId)).groupBy(playerTechs.playerId);
  for (const t of techs) {
    const a = arcs.get(t.playerId);
    if (a) a.techs = t.n;
  }
  return arcs;
}

/** The story of a match: lead changes, the biggest battle, the ice, the eliminations, and a few paragraphs that tell it. */
export async function buildStory(db: Db, m: MatchRow, ps: PlayerRow[], standings: Array<{ id: string; name: string; score: number; regions: number; population: number; age: number; eliminated: boolean; won: boolean }>): Promise<MatchStory> {
  const nameOf = new Map(ps.map((p) => [p.id, p.name]));
  const finished = m.status === "finished";
  const dayOf = (at: Date) => ((at.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed;

  // Who led each day, and when that changed hands.
  const hist = await db.select({ playerId: scoreHistory.playerId, day: scoreHistory.day, score: scoreHistory.score }).from(scoreHistory).where(eq(scoreHistory.matchId, m.id)).orderBy(asc(scoreHistory.day));
  const leaders = new Map<number, { playerId: string; score: number }>();
  for (const h of hist) {
    const cur = leaders.get(h.day);
    if (!cur || h.score > cur.score) leaders.set(h.day, { playerId: h.playerId, score: h.score });
  }
  const leadChanges: MatchStory["leadChanges"] = [];
  let last: string | null = null;
  for (const day of [...leaders.keys()].sort((a, b) => a - b)) {
    const l = leaders.get(day)!;
    if (l.playerId !== last) {
      leadChanges.push({ day, playerId: l.playerId, playerName: nameOf.get(l.playerId) ?? "a tribe" });
      last = l.playerId;
    }
  }

  // The biggest battle by units lost on both sides.
  const fights = await db.select().from(battles).where(eq(battles.matchId, m.id));
  let biggest: MatchStory["biggestBattle"] = null;
  for (const f of fights) {
    const r = f.report as { attackerName?: string; defenderName?: string; regionName?: string; attackerWon?: boolean; conquered?: boolean; attacker?: { losses?: Record<string, number> }; defender?: { losses?: Record<string, number> } };
    const losses = Object.values(r.attacker?.losses ?? {}).reduce((a, b) => a + b, 0) + Object.values(r.defender?.losses ?? {}).reduce((a, b) => a + b, 0);
    if (!biggest || losses > biggest.losses) {
      biggest = { day: Math.floor(dayOf(f.resolvedAt)) + 1, regionName: r.regionName ?? regionById(f.regionId)?.name ?? f.regionId, attackerName: r.attackerName ?? "a tribe", defenderName: r.defenderName ?? "the defenders", losses, attackerWon: !!r.attackerWon, conquered: !!r.conquered };
    }
  }

  const kinds = await db.select({ kind: events.kind, n: sql<number>`count(*)::int` }).from(events).where(eq(events.matchId, m.id)).groupBy(events.kind);
  const counts: Record<string, number> = {};
  for (const k of kinds) counts[k.kind] = k.n;

  const lastDay = finished ? balance.match.lengthDays : Math.min(balance.match.lengthDays, Math.max(0, dayOf(new Date())));
  const iceLatitude = Math.round(iceLatitudeOnDay(lastDay));
  const eliminated = standings.filter((s) => s.eliminated).length;

  // The tournaments on either side, for the reader who wants the next story.
  const neighbours = async (dir: "prev" | "next") => {
    const rows = await db
      .select({ slug: matches.slug, name: matches.name, id: matches.id })
      .from(matches)
      .where(and(eq(matches.status, "finished"), sql`${matches.settings}->>'kind' = 'tournament'`, dir === "prev" ? lt(matches.startsAt, m.startsAt) : gt(matches.startsAt, m.startsAt)))
      .orderBy(dir === "prev" ? desc(matches.startsAt) : asc(matches.startsAt))
      .limit(1);
    const r = rows[0];
    return r ? { slug: r.slug ?? r.id, name: r.name } : null;
  };
  const [prev, next] = isTournament(m.settings) ? await Promise.all([neighbours("prev"), neighbours("next")]) : [null, null];

  const winner = standings.find((s) => s.won) ?? standings[0];
  const howWon = winner && finished ? howWonLine(m.winKind, winner.name, "Great Hearth", winner.population, winner.regions) : "";
  const paragraphs: string[] = [];
  if (finished && winner) {
    const humans = ps.filter((p) => !p.isAi).length;
    const ages = Math.max(0, ...standings.map((s) => s.age));
    const reachedTop = standings.filter((s) => s.age === ages).length;
    paragraphs.push(
      `${m.name} was a ${isTournament(m.settings) ? "ranked tournament" : "game"} of ${standings.length} tribes${humans ? `, ${humans} of them played by people,` : ""} fought over ${balance.match.lengthDays} days at ${m.speed}x. ${howWon} ${winner.name} finished with ${fmt(winner.score)} points in the ${ageName(winner.age)} Age${standings[1] ? `, ahead of ${standings[1].name} on ${fmt(standings[1].score)}` : ""}.`,
    );
    const leadLine =
      leadChanges.length <= 1
        ? `${leadChanges[0]?.playerName ?? winner.name} led from the first day to the last.`
        : `The lead changed hands ${leadChanges.length - 1} time${leadChanges.length === 2 ? "" : "s"}: ${leadChanges
            .slice(1)
            .map((c) => `${c.playerName} on day ${c.day + 1}`)
            .join(", ")}.`;
    const fightLine = biggest
      ? ` The biggest battle came on day ${biggest.day} at ${biggest.regionName}, where ${biggest.attackerName} ${biggest.conquered ? "took the region from" : biggest.attackerWon ? "beat" : "broke against"} ${biggest.defenderName} and ${fmt(biggest.losses)} fighters fell between them.`
      : fights.length === 0
        ? " Not a single battle was fought."
        : "";
    paragraphs.push(`${leadLine}${fightLine} ${fights.length ? `${fmt(fights.length)} battles were fought in all.` : ""}`.trim());
    const worldBits: string[] = [];
    if (counts["horde.sighted"]) worldBits.push(`the Northern Horde came down ${counts["horde.sighted"]} time${counts["horde.sighted"] === 1 ? "" : "s"}`);
    if (counts["plague.outbreak"]) worldBits.push(`sickness broke out ${counts["plague.outbreak"]} time${counts["plague.outbreak"] === 1 ? "" : "s"}`);
    if (counts["storm.hit"]) worldBits.push(`${counts["storm.hit"]} blizzard${counts["storm.hit"] === 1 ? "" : "s"} landed`);
    if (counts["pact.made"]) worldBits.push(`${counts["pact.made"]} pact${counts["pact.made"] === 1 ? "" : "s"} ${counts["pact.made"] === 1 ? "was" : "were"} sworn`);
    if (counts["expedition.returned"]) worldBits.push(`${counts["expedition.returned"]} expedition${counts["expedition.returned"] === 1 ? "" : "s"} returned`);
    paragraphs.push(
      `By the end the ice had reached ${iceLatitude}° of latitude, ${eliminated === 0 ? "and every tribe was still standing" : `and ${eliminated} tribe${eliminated === 1 ? " was" : "s were"} gone`}. ${reachedTop} tribe${reachedTop === 1 ? "" : "s"} reached the ${ageName(ages)} Age${worldBits.length ? `; ${worldBits.join(", ")}` : ""}.`,
    );
  }
  return { paragraphs, howWon, leadChanges, biggestBattle: biggest, iceLatitude, eliminated, counts, prev, next };
}
