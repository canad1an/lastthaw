import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { AGES, balance, freezeDayForLatitude, regionById, seededRng, type AgeIndex } from "@lastthaw/shared";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { battles, chatMessages, discordPosts, matchRegions, players, tribeChatPosts } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
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
  // In the match chat there is no match to name; on Discord there is.
  const where = f.match ? ` in ${f.match}` : "";
  const openers: Record<Temperament, readonly string[]> = {
    peaceful: [`Day ${f.day}${where}.`, `Quiet morning on day ${f.day}.`, `${f.tribe} checking in, day ${f.day}.`, `Day ${f.day}: the fires are lit and the granaries are filling.`],
    balanced: [`Day ${f.day}${where}.`, `${f.tribe}, day ${f.day}.`, `Day ${f.day} report from ${f.capital ?? "the capital"}.`, `Day ${f.day}. Still here.`],
    raider: [`Day ${f.day}. Sharpening spears.`, `${f.tribe} here. Day ${f.day} and the men are restless.`, `Day ${f.day}${where}: good hunting.`, `Day ${f.day}. Who left their stores unguarded?`],
  };
  lines.push(pick(rng, openers[f.temperament]));
  const holdings = [
    `We hold ${f.regions} region${f.regions === 1 ? "" : "s"} and the ${age} Age is ours.`,
    `${f.regions} region${f.regions === 1 ? "" : "s"} under our banner, ${age} Age tools in every hand.`,
    `${age} Age, ${f.regions} region${f.regions === 1 ? "" : "s"}. Not bad for five settlers.`,
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

/** How a tribe reacts to a battle it was in, for the match chat. Deterministic for a seed. */
export function composeBattleLine(b: { attacker: boolean; won: boolean; other: string; region: string; conquered: boolean; temperament: Temperament }, rng: () => number): string {
  const t = b.temperament;
  if (b.attacker && b.won && b.conquered) return pick(rng, [`${b.region} is ours. ${b.other}, you can have it back when the ice does.`, `Took ${b.region} from ${b.other}. The settlers are already unpacking.`, t === "raider" ? `${b.region} fell. ${b.other} fought like people who had somewhere else to be.` : `${b.region} changed hands today. Nothing personal, ${b.other}.`]);
  if (b.attacker && b.won) return pick(rng, [`Raided ${b.region}. ${b.other}'s granaries are lighter tonight.`, `${b.other} left ${b.region} open. We closed it for them.`, t === "raider" ? `Good night's work at ${b.region}. Thanks, ${b.other}.` : `A quick visit to ${b.region}. We needed the stone, ${b.other}.`]);
  if (b.attacker && !b.won) return pick(rng, [`${b.other} held ${b.region}. Respect. Walls are expensive for a reason.`, `We came up short at ${b.region}. ${b.other} will not get that lucky twice.`, t === "peaceful" ? `Should have stayed home. ${b.other} held ${b.region} and we lost good people.` : `Lost at ${b.region}. ${b.other}, enjoy it while it lasts.`]);
  if (!b.attacker && b.won) return pick(rng, [`${b.other} tried ${b.region}. They are walking home with fewer friends.`, `Held ${b.region}. ${b.other}, the palisade sends its regards.`, t === "raider" ? `${b.other} knocked on ${b.region}. We answered.` : `${b.region} stands. ${b.other}, try trading next time.`]);
  if (b.conquered) return pick(rng, [`${b.other} took ${b.region}. We will remember the day.`, `Lost ${b.region} to ${b.other}. The ice would have had it anyway, but not yet.`, t === "raider" ? `${b.other} has ${b.region} for now. For now.` : `${b.region} is gone to ${b.other}. Rebuilding further south.`]);
  return pick(rng, [`${b.other} raided ${b.region}. Watch your borders, everyone; they are hungry.`, `Lost stores at ${b.region} to ${b.other}. Storehouses going up tonight.`, t === "peaceful" ? `${b.other} hit ${b.region}. We did not want this fight.` : `${b.other} got in and out of ${b.region}. Next time they get in only.`]);
}

/** The facts a tribe speaks from, as they stand right now. */
async function gatherFacts(tx: Tx, m: MatchRow, p: typeof players.$inferSelect, day: number, matchName: string): Promise<TribeFacts> {
  const alive = await tx.select().from(players).where(and(eq(players.matchId, m.id), eq(players.hidden, false), isNull(players.eliminatedAt)));
  const standings = [...alive].sort((a, b) => b.score - a.score);
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt)));
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
  return {
    tribe: p.name,
    match: matchName,
    day,
    age: p.age as AgeIndex,
    regions: count?.n ?? 0,
    rank: standings.findIndex((s) => s.id === p.id) + 1,
    of: standings.length,
    capital: p.capitalRegionId ? (regionById(p.capitalRegionId)?.name ?? null) : null,
    daysToIce: freeze !== null ? freeze - day : null,
    lastBattle: b && report ? { won: attacker ? !!report.attackerWon : !report.attackerWon, attacker, other: (attacker ? report.defenderName : report.attackerName) ?? "a neighbour", region: report.regionName ?? "the border" } : null,
    leader: standings[0] && standings[0].id !== p.id ? standings[0].name : null,
    temperament: parseProfile(p.aiProfile).temperament,
  };
}

/** Put a line in the match's global chat as the tribe, and tell the clients. */
async function sayInChat(tx: Tx, m: MatchRow, p: { id: string; name: string }, body: string, at: Date, publisher: Publisher, after: (fn: () => Promise<void>) => void): Promise<void> {
  const [row] = await tx.insert(chatMessages).values({ matchId: m.id, channel: "global", playerId: p.id, playerName: p.name, body, sentAt: at }).returning();
  if (!row) return;
  const payload = { channel: "global", id: row.id, playerId: p.id, playerName: p.name, body, sentAt: at.toISOString() };
  after(() => publisher.toMatch(m.id, "chat.message", payload));
}

/** Day hook, every match: AI tribes due to speak in the match chat today say their piece, once. */
export async function tribesChat(tx: Tx, m: MatchRow, day: number, at: Date, publisher: Publisher, after: (fn: () => Promise<void>) => void): Promise<number> {
  const tribes = await tx
    .select()
    .from(players)
    .where(and(eq(players.matchId, m.id), eq(players.isAi, true), eq(players.hidden, false), isNull(players.eliminatedAt)));
  // A different seed from the Discord schedule, so the two do not land on the same days.
  const due = tribes.filter((p) => postingDays(`${m.seed}:chat`, p.id).includes(day));
  if (due.length === 0) return 0;
  const already = new Set((await tx.select({ playerId: tribeChatPosts.playerId }).from(tribeChatPosts).where(and(eq(tribeChatPosts.matchId, m.id), eq(tribeChatPosts.day, day), eq(tribeChatPosts.kind, "scheduled")))).map((r) => r.playerId));
  let posted = 0;
  for (const p of due) {
    if (already.has(p.id)) continue;
    const facts = await gatherFacts(tx, m, p, day, "");
    const text = composePost(facts, seededRng(`${m.seed}:chat:${p.id}:${day}`));
    await tx.insert(tribeChatPosts).values({ matchId: m.id, playerId: p.id, day, kind: "scheduled" });
    await sayInChat(tx, m, p, text, at, publisher, after);
    posted += 1;
  }
  return posted;
}

/**
 * After a battle: an AI tribe that took or lost a region, or won or lost a fight
 * with real losses, says something in the match chat. At most once a day per
 * tribe, and not every time, so the chat is not a battle log.
 */
export async function tribeBattleTalk(
  tx: Tx,
  m: MatchRow,
  battle: { attackerId: string; defenderId: string | null; attackerName: string; defenderName: string; region: string; attackerWon: boolean; conquered: boolean; losses: number; seed: string },
  at: Date,
  publisher: Publisher,
  after: (fn: () => Promise<void>) => void,
): Promise<number> {
  const major = battle.conquered || battle.losses >= balance.discord.battleLossesToTalk;
  if (!major) return 0;
  const day = Math.floor(((at.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed);
  const ids = [battle.attackerId, ...(battle.defenderId ? [battle.defenderId] : [])];
  const tribes = await tx.select().from(players).where(and(inArray(players.id, ids), eq(players.isAi, true), eq(players.hidden, false), isNull(players.eliminatedAt)));
  let posted = 0;
  for (const p of tribes) {
    const rng = seededRng(`${m.seed}:battle:${battle.seed}:${p.id}`);
    if (rng() > balance.discord.battleTalkChance) continue;
    const inserted = await tx.insert(tribeChatPosts).values({ matchId: m.id, playerId: p.id, day, kind: "battle" }).onConflictDoNothing().returning({ day: tribeChatPosts.day });
    if (inserted.length === 0) continue;
    const attacker = p.id === battle.attackerId;
    const line = composeBattleLine({ attacker, won: attacker ? battle.attackerWon : !battle.attackerWon, other: attacker ? battle.defenderName : battle.attackerName, region: battle.region, conquered: battle.conquered, temperament: parseProfile(p.aiProfile).temperament }, rng);
    await sayInChat(tx, m, p, line, at, publisher, after);
    posted += 1;
  }
  return posted;
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
  let posted = 0;
  for (const p of due) {
    if (already.has(p.id)) continue;
    const facts = await gatherFacts(tx, m, p, day, m.name);
    const text = composePost(facts, seededRng(`${m.seed}:voice:${p.id}:${day}`));
    await tx.insert(discordPosts).values({ matchId: m.id, playerId: p.id, day, body: text });
    after(() => postToDiscord(p.name, text).then(() => undefined));
    posted += 1;
  }
  return posted;
}
