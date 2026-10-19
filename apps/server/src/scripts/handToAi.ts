/**
 * Hand a human's tribe in a running match to the AI: the tribe keeps its regions, people, armies and queues and
 * plays on under a new name as a medium AI; the account is no longer in the match.
 *
 *   node dist/scripts/handToAi.js 2026-10-frozen-vanguard "Canad1an"      (production, inside the api image)
 *   npx tsx src/scripts/handToAi.ts <slug or id> "<tribe name>"            (local)
 */
import { and, eq, sql } from "drizzle-orm";
import { balance, seededRng } from "@lastthaw/shared";
import { createDb } from "../db/client.js";
import { matches, players } from "../db/schema.js";
import { resolveMatchRef } from "../matches/slug.js";
import { randomProfile } from "../sim/ai.js";

const arg = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (arg.endsWith("/handToAi.js") || arg.endsWith("/handToAi.ts")) {
  const [ref, tribe] = process.argv.slice(2);
  if (!ref || !tribe) {
    console.error('usage: handToAi <match slug or id> "<tribe name>"');
    process.exit(2);
  }
  const db = createDb();
  const id = await resolveMatchRef(db, ref);
  if (!id || id === "bad") {
    console.error("no such match");
    await db.close();
    process.exit(2);
  }
  const [m] = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
  const [p] = await db.select().from(players).where(and(eq(players.matchId, id), eq(players.name, tribe), eq(players.isAi, false))).limit(1);
  if (!m || !p) {
    console.error(`no human tribe called "${tribe}" in that match`);
    await db.close();
    process.exit(2);
  }
  // A name no tribe in the match already carries.
  const taken = new Set((await db.select({ name: players.name }).from(players).where(eq(players.matchId, id))).map((x) => x.name));
  const rng = seededRng(`${m.seed}:handover:${p.id}`);
  const name = [...balance.ai.names].sort(() => rng() - 0.5).find((n) => !taken.has(n)) ?? `${tribe}'s heirs`;
  const settings = (m.settings ?? {}) as { aiDifficulty?: string };
  await db
    .update(players)
    .set({ isAi: true, userId: null, name, aiProfile: randomProfile(rng, settings.aiDifficulty ?? "medium"), nextAiAt: new Date(), protectionUntil: new Date() })
    .where(eq(players.id, p.id));
  void sql;
  console.log(JSON.stringify({ match: ref, was: tribe, now: name, playerId: p.id }));
  await db.close();
}
