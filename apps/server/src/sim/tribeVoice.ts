import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { AGES, balance, freezeDayForLatitude, regionById, seededRng, type AgeIndex } from "@lastthaw/shared";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { battles, discordPosts, matchRegions, players } from "../db/schema.js";
import { parseProfile, type Temperament } from "./ai.js";
import type { Tx } from "./regions.js";
import type { MatchRow } from "../worker/jobs.js";
import { isTournament } from "../matches/registrations.js";

/**
 * The tribes talk. During a tournament each AI tribe posts to the Discord
 * server a few times (one to ten, chosen once per match from the seed) on days
 * chosen the same way, in its own voice, about what it is actually doing on
 * the map. Posts go through a Discord webhook with the tribe's name on them.
 */

export interface TribeFacts {
  tribe: string;
  match: string;
  day: number;
  age: AgeIndex;
  regions: number;
  rank: number;
  of: number;
  capital: string | null;
  daysToIce: number | null;
  lastBattle: { won: boolean; attacker: boolean; other: string; region: string } | null;
  leader: string | null;
  temperament: Temperament;
}

/** How many posts this tribe makes in this match, and on which days. Fixed by the match seed and the player. */
export function postingDays(seed: string, playerId: string, lengthDays = balance.match.lengthDays): number[] {
  const rng = seededRng(`${seed}:voice:${playerId}`);
  const c = balance.discord.postsPerTribe;
  const n = c.min + Math.floor(rng() * (c.max - c.min + 1));
  const days = new Set<number>();
  while (days.size < n) days.add(1 + Math.floor(rng() * (lengthDays - 1)));
  return [...days].sort((a, b) => a - b);
}

const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

/** A short post in the tribe's voice, from what it is really doing. Deterministic for a seed. */
export function composePost(f: TribeFacts, rng: () => number): string {
  const age = AGES[f.age];
  const lines: string[] = [];
  const openers: Record<Temperament, readonly string[]> = {
    peaceful: [`Day ${f.day} in ${f.match}.`, `Quiet morning on day ${f.day}.`, `${f.tribe} checking in, day ${f.day}.`, `Day ${f.day}: the fires are lit and the granaries are filling.`],
    balanced: [`Day ${f.day} in ${f.match}.`, `${f.tribe}, day ${f.day}.`, `Day ${f.day} report from ${f.capital ?? "the capital"}.`, `Day ${f.day}. Still here.`],
    raider: [`Day ${f.day}. Sharpening spears.`, `${f.tribe} here. Day ${f.day} and the men are restless.`, `Day ${f.day} in ${f.match}: good hunting.`, `Day ${f.day}. Who left their stores unguarded?`],
  };
  lines.push(pick(rng, openers[f.temperament]));
  const holdings = [
    `We hold ${f.regions} region${f.regions === 1 ? "" : "s"} and the ${age} Age is ours.`,
    `${f.regions} region${f.regions === 1 ? "" : "s"} under our banner, ${age} Age tools in every hand.`,
    `${age} Age, ${f.regions} region${f.regions === 1 ? "" : "s"}. Not bad for five families.`,
  ];
  lines.push(pick(rng, holdings));
  if (f.rank === 1 && f.of > 1) lines.push(pick(rng, ["Top of the board for now; the others know where to find us.", "First place. The ice is the only thing we are watching.", "Leading the standings. Come and take it."]));
  else if (f.rank <= 3) lines.push(pick(rng, [`Third or better of ${f.of}, and climbing.`, `Near the top of ${f.of} tribes. ${f.leader ? `${f.leader} is ahead, for now.` : ""}`.trim()]));
  else if (f.leader) lines.push(pick(rng, [`${f.leader} is leading. Nobody stays leading for thirty days.`, `Rank ${f.rank} of ${f.of}. ${f.leader} has the lead and a lot of borders.`, `Behind ${f.leader} on the board. Long month ahead.`]));
  if (f.lastBattle) {
    const b = f.lastBattle;
    if (b.attacker && b.won) lines.push(pick(rng, [`Our raid on ${b.region} went well; ${b.other} will want it back.`, `Took what we needed from ${b.other} at ${b.region}.`, `${b.region} was lightly held. ${b.other} knows better now.`]));
    else if (b.attacker && !b.won) lines.push(pick(rng, [`${b.other} held ${b.region}. We will remember the walls.`, `Lost men at ${b.region}. ${b.other} fights well; we fight again.`]));
    else if (!b.attacker && b.won) lines.push(pick(rng, [`${b.other} came for ${b.region} and went home lighter.`, `Held ${b.region} against ${b.other}. The palisade earned its wood.`]));
    else lines.push(pick(rng, [`${b.other} hit ${b.region}. It will not happen twice.`, `Lost a fight at ${b.region} to ${b.other}. Walls are going up.`]));
  }
  if (f.daysToIce !== null && f.daysToIce <= 4) lines.push(pick(rng, [`The ice is ${Math.max(1, Math.round(f.daysToIce))} day${Math.round(f.daysToIce) === 1 ? "" : "s"} from ${f.capital ?? "the capital"}. Wagons are loading.`, `${Math.max(1, Math.round(f.daysToIce))} day${Math.round(f.daysToIce) === 1 ? "" : "s"} of warmth left at ${f.capital ?? "home"}. South it is.`]));
  else if (f.daysToIce !== null && f.daysToIce <= 10) lines.push(pick(rng, [`The frost reaches ${f.capital ?? "us"} in about ${Math.round(f.daysToIce)} days. Settlers are heading south.`, `${Math.round(f.daysToIce)} days until the ice takes ${f.capital ?? "the capital"}. Enough time, if nobody interferes.`]));
  else if (rng() < 0.35) lines.push(pick(rng, ["Trade route to the coast is open if anyone has iron.", "Looking for a non-aggression pact with a sensible neighbour.", "Our scouts saw a horde camp to the north. Lock your doors.", "Any tribe with horses to spare, the market is open."]));
  return lines.join(" ");
}

/** Post to the Discord server as the tribe. Quietly does nothing without a webhook. */
export async function postToDiscord(username: string, content: string): Promise<boolean> {
  const url = config().DISCORD_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, content, allowed_mentions: { parse: [] } }) });
    if (!res.ok) logger.warn({ status: res.status, username }, "discord post refused");
    return res.ok;
  } catch (err) {
    logger.warn({ err, username }, "discord post failed");
    return false;
  }
}

/** Day hook: every AI tribe due to speak today, in a tournament, says its piece once. */
export async function tribesSpeak(tx: Tx, m: MatchRow, day: number, after: (fn: () => Promise<void>) => void): Promise<number> {
  if (!isTournament(m.settings) || !config().DISCORD_WEBHOOK_URL) return 0;
  const tribes = await tx
    .select()
    .from(players)
    .where(and(eq(players.matchId, m.id), eq(players.isAi, true), eq(players.hidden, false), isNull(players.eliminatedAt)));
  const due = tribes.filter((p) => postingDays(m.seed, p.id).includes(day));
  if (due.length === 0) return 0;
  const already = new Set((await tx.select({ playerId: discordPosts.playerId }).from(discordPosts).where(and(eq(discordPosts.matchId, m.id), eq(discordPosts.day, day)))).map((r) => r.playerId));
  const standings = [...tribes, ...(await tx.select().from(players).where(and(eq(players.matchId, m.id), eq(players.isAi, false), isNull(players.eliminatedAt))))].sort((a, b) => b.score - a.score);
  const counts = new Map(
    (await tx.select({ owner: matchRegions.ownerPlayerId, n: sql<number>`count(*)::int` }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), isNull(matchRegions.frozenAt), inArray(matchRegions.ownerPlayerId, standings.map((p) => p.id)))).groupBy(matchRegions.ownerPlayerId)).map((r) => [r.owner!, r.n]),
  );
  let posted = 0;
  for (const p of due) {
    if (already.has(p.id)) continue;
    const [b] = await tx
      .select()
      .from(battles)
      .where(and(eq(battles.matchId, m.id), or(eq(battles.attackerPlayerId, p.id), eq(battles.defenderPlayerId, p.id))))
      .orderBy(desc(battles.resolvedAt))
      .limit(1);
    const report = (b?.report ?? null) as { attackerWon?: boolean; attackerName?: string; defenderName?: string; regionName?: string } | null;
    const attacker = b?.attackerPlayerId === p.id;
    const capLat = p.capitalRegionId ? Math.abs(regionById(p.capitalRegionId)?.lat ?? 0) : null;
    const freeze = capLat !== null ? freezeDayForLatitude(capLat) : null;
    const facts: TribeFacts = {
      tribe: p.name,
      match: m.name,
      day,
      age: p.age as AgeIndex,
      regions: counts.get(p.id) ?? 0,
      rank: standings.findIndex((s) => s.id === p.id) + 1,
      of: standings.length,
      capital: p.capitalRegionId ? (regionById(p.capitalRegionId)?.name ?? null) : null,
      daysToIce: freeze !== null ? freeze - day : null,
      lastBattle: b && report ? { won: attacker ? !!report.attackerWon : !report.attackerWon, attacker, other: (attacker ? report.defenderName : report.attackerName) ?? "a neighbour", region: report.regionName ?? "the border" } : null,
      leader: standings[0] && standings[0].id !== p.id ? standings[0].name : null,
      temperament: parseProfile(p.aiProfile).temperament,
    };
    const text = composePost(facts, seededRng(`${m.seed}:voice:${p.id}:${day}`));
    await tx.insert(discordPosts).values({ matchId: m.id, playerId: p.id, day, body: text });
    after(() => postToDiscord(p.name, text).then(() => undefined));
    posted += 1;
  }
  return posted;
}
