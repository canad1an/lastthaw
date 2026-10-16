import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { placeBounty } from "./objectives.js";
import { balance, regionById } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { events, matchRegions, pacts, players, transfers } from "../db/schema.js";
import { httpError } from "./commands.js";
import { applyCost, settleAndLockRegion, stockOf, type Tx } from "./regions.js";
import { notify, type MatchRow } from "../worker/jobs.js";
import { matchNow } from "./clock.js";

type PactRow = typeof pacts.$inferSelect;
type PlayerRow = typeof players.$inferSelect;

/** Game hours → real milliseconds at this match's speed. */
const hoursMs = (m: MatchRow, h: number) => (h * 3600_000) / m.speed;

/** A non-aggression pact or ceasefire in force between two players (active, or ending with notice still running). */
export async function peaceBetween(db: Db | Tx, matchId: string, a: string, b: string, at: Date): Promise<PactRow | null> {
  const [p] = await db
    .select()
    .from(pacts)
    .where(
      and(
        eq(pacts.matchId, matchId),
        inArray(pacts.kind, ["nap", "ceasefire"]),
        inArray(pacts.status, ["active", "ending"]),
        or(and(eq(pacts.aPlayerId, a), eq(pacts.bPlayerId, b)), and(eq(pacts.aPlayerId, b), eq(pacts.bPlayerId, a))),
        or(isNull(pacts.until), gt(pacts.until, at)),
      ),
    )
    .limit(1);
  return p ?? null;
}

/** Cause for war: `attacker` demanded tribute, `defender` refused, and the window is still open. */
export async function causeForWar(db: Db | Tx, matchId: string, attacker: string, defender: string, at: Date): Promise<boolean> {
  const [p] = await db
    .select({ id: pacts.id })
    .from(pacts)
    .where(and(eq(pacts.matchId, matchId), eq(pacts.kind, "tribute"), eq(pacts.status, "refused"), eq(pacts.aPlayerId, attacker), eq(pacts.bPlayerId, defender), gt(pacts.until, at)))
    .limit(1);
  return !!p;
}

/** Propose a pact or ceasefire, or demand tribute. `a` proposes; `b` answers. */
export async function proposePact(db: Db, m: MatchRow, me: PlayerRow, otherId: string, kind: "nap" | "ceasefire" | "tribute", terms?: { resource: string; amount: number }): Promise<PactRow> {
  if (otherId === me.id) throw httpError(400, "that is you");
  const [other] = await db.select().from(players).where(and(eq(players.matchId, m.id), eq(players.id, otherId), eq(players.hidden, false))).limit(1);
  if (!other || other.eliminatedAt) throw httpError(404, "no such player in this match");
  const now = matchNow(m);
  const d = balance.events.diplomacy;
  if (kind !== "tribute" && (await peaceBetween(db, m.id, me.id, otherId, now))) throw httpError(409, "you already have peace with them");
  const [pending] = await db
    .select({ id: pacts.id })
    .from(pacts)
    .where(and(eq(pacts.matchId, m.id), eq(pacts.kind, kind), eq(pacts.status, "proposed"), or(and(eq(pacts.aPlayerId, me.id), eq(pacts.bPlayerId, otherId)), and(eq(pacts.aPlayerId, otherId), eq(pacts.bPlayerId, me.id)))))
    .limit(1);
  if (pending) throw httpError(409, "there is already an open proposal between you");
  if (kind === "tribute") {
    if (!terms || terms.amount < 1) throw httpError(400, "say what you demand");
    const [recent] = await db
      .select({ id: pacts.id })
      .from(pacts)
      .where(and(eq(pacts.matchId, m.id), eq(pacts.kind, "tribute"), eq(pacts.aPlayerId, me.id), eq(pacts.bPlayerId, otherId), gt(pacts.createdAt, new Date(now.getTime() - hoursMs(m, d.tributeCooldownHours)))))
      .limit(1);
    if (recent) throw httpError(409, `one demand per ${d.tributeCooldownHours} hours`);
  }
  const until = kind === "tribute" ? new Date(now.getTime() + hoursMs(m, d.tributeHours)) : null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(pacts)
      .values({ matchId: m.id, kind, aPlayerId: me.id, bPlayerId: otherId, proposedBy: me.id, status: "proposed", until, terms: terms ?? {} })
      .returning();
    const what = kind === "nap" ? "a non-aggression pact" : kind === "ceasefire" ? `a ${d.ceasefireHours}-hour ceasefire` : `tribute: ${terms!.amount} ${terms!.resource} within ${d.tributeHours} hours`;
    await notify(tx, m.id, otherId, "alliance", `${me.name} ${kind === "tribute" ? "demands" : "proposes"} ${what}. Answer in the Diplomacy section of the Alliance menu.`, { pactId: row!.id, kind, from: me.id, diplomacy: true });
    return row!;
  });
}

/** Accept or decline a proposal; pacts take effect at once, ceasefires run their fixed time. */
export async function respondPact(db: Db, m: MatchRow, me: PlayerRow, pactId: string, accept: boolean): Promise<PactRow> {
  const now = matchNow(m);
  const d = balance.events.diplomacy;
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(pacts).where(and(eq(pacts.id, pactId), eq(pacts.matchId, m.id), eq(pacts.status, "proposed"))).for("update");
    if (!p || p.bPlayerId !== me.id) throw httpError(404, "no such proposal waiting for you");
    if (p.kind === "tribute") {
      if (accept) throw httpError(400, "tribute is paid, not accepted");
      return refuseTribute(tx, m, p, now);
    }
    const [row] = await tx
      .update(pacts)
      .set(accept ? { status: "active", until: p.kind === "ceasefire" ? new Date(now.getTime() + hoursMs(m, d.ceasefireHours)) : null, decidedAt: now } : { status: "declined", decidedAt: now })
      .where(eq(pacts.id, p.id))
      .returning();
    const [other] = await tx.select({ name: players.name }).from(players).where(eq(players.id, p.aPlayerId)).limit(1);
    await notify(tx, m.id, p.aPlayerId, "alliance", `${me.name} ${accept ? "accepted" : "declined"} your ${p.kind === "nap" ? "non-aggression pact" : "ceasefire"}.`, { pactId: p.id, diplomacy: true });
    if (accept) await tx.insert(events).values({ matchId: m.id, at: now, kind: "pact.made", payload: { a: p.aPlayerId, b: p.bPlayerId, kind: p.kind } });
    void other;
    return row!;
  });
}

/** Give notice on a pact: it stays in force for `napNoticeHours`, then ends. Ceasefires run out on their own. */
export async function endPact(db: Db, m: MatchRow, me: PlayerRow, pactId: string): Promise<PactRow> {
  const now = matchNow(m);
  const d = balance.events.diplomacy;
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(pacts).where(and(eq(pacts.id, pactId), eq(pacts.matchId, m.id), eq(pacts.status, "active"), eq(pacts.kind, "nap"))).for("update");
    if (!p || (p.aPlayerId !== me.id && p.bPlayerId !== me.id)) throw httpError(404, "no such pact of yours");
    const until = new Date(now.getTime() + hoursMs(m, d.napNoticeHours));
    const [row] = await tx.update(pacts).set({ status: "ending", until }).where(eq(pacts.id, p.id)).returning();
    const other = p.aPlayerId === me.id ? p.bPlayerId : p.aPlayerId;
    await notify(tx, m.id, other, "alliance", `${me.name} has given notice: your pact ends in ${d.napNoticeHours} hours.`, { pactId: p.id, until: until.toISOString(), diplomacy: true });
    await tx.insert(events).values({ matchId: m.id, at: now, kind: "pact.ending", payload: { by: me.id, other, until: until.toISOString() } });
    return row!;
  });
}

/** Pay a tribute demand from the capital; it goes on the transfer ledger. */
export async function payTribute(db: Db, m: MatchRow, me: PlayerRow, pactId: string): Promise<{ ok: true }> {
  const now = matchNow(m);
  if (!me.capitalRegionId) throw httpError(409, "you have no capital to pay from");
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(pacts).where(and(eq(pacts.id, pactId), eq(pacts.matchId, m.id), eq(pacts.kind, "tribute"), eq(pacts.status, "proposed"))).for("update");
    if (!p || p.bPlayerId !== me.id) throw httpError(404, "no such demand on you");
    if (p.until && p.until <= now) throw httpError(409, "the deadline has passed");
    const terms = p.terms as { resource: string; amount: number };
    const [other] = await tx.select().from(players).where(eq(players.id, p.aPlayerId)).limit(1);
    if (!other) throw httpError(404, "the demander is gone");
    const ids = [...new Set([me.capitalRegionId!, ...(other.capitalRegionId ? [other.capitalRegionId] : [])])].sort();
    const locked = new Map<string, Awaited<ReturnType<typeof settleAndLockRegion>>>();
    for (const id of ids) locked.set(id, await settleAndLockRegion(tx, m.id, id, now, m.speed));
    const mine = locked.get(me.capitalRegionId!)!;
    if ((stockOf(mine)[terms.resource] ?? 0) < terms.amount) throw httpError(409, `your capital does not have ${terms.amount} ${terms.resource}`);
    await applyCost(tx, mine, { [terms.resource]: terms.amount });
    const theirs = other.capitalRegionId ? locked.get(other.capitalRegionId) : null;
    if (theirs && theirs.ownerPlayerId === other.id) {
      const cur = (theirs as Record<string, unknown>)[terms.resource];
      if (typeof cur === "number") await tx.update(matchRegions).set({ [terms.resource]: cur + terms.amount }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, theirs.regionId)));
      else {
        const special = { ...(theirs.special as Record<string, number>) };
        special[terms.resource] = (special[terms.resource] ?? 0) + terms.amount;
        await tx.update(matchRegions).set({ special }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, theirs.regionId)));
      }
    }
    await tx.insert(transfers).values({ matchId: m.id, fromPlayerId: me.id, toPlayerId: other.id, resource: terms.resource, amount: terms.amount, via: "tribute", at: now });
    await tx.update(pacts).set({ status: "paid", decidedAt: now }).where(eq(pacts.id, p.id));
    await notify(tx, m.id, other.id, "alliance", `${me.name} paid your tribute: ${terms.amount} ${terms.resource} arrived at ${regionById(other.capitalRegionId ?? "")?.name ?? "your capital"}.`, { pactId: p.id, diplomacy: true });
    await tx.insert(events).values({ matchId: m.id, at: now, kind: "tribute.paid", payload: { from: me.id, to: other.id, ...terms } });
    return { ok: true as const };
  });
}

/**
 * A tribute demand is turned down, by the player or by the clock running out. The demander is told, gets cause for war
 * (double loot on raids for `causeForWarHours`), and a bounty on the refuser's capital stock goes up for everyone.
 */
async function refuseTribute(tx: Tx, m: MatchRow, p: PactRow, now: Date, expired = false): Promise<PactRow> {
  const d = balance.events.diplomacy;
  const window = new Date(now.getTime() + hoursMs(m, d.causeForWarHours));
  const [row] = await tx.update(pacts).set({ status: "refused", until: window, decidedAt: now }).where(eq(pacts.id, p.id)).returning();
  const [refuser] = await tx.select({ capital: players.capitalRegionId, name: players.name }).from(players).where(eq(players.id, p.bPlayerId)).limit(1);
  const name = refuser?.name ?? "They";
  const how = expired ? `let your tribute demand lapse` : `rejected your tribute demand`;
  await notify(tx, m.id, p.aPlayerId, "alliance", `${name} ${how}. For ${d.causeForWarHours} hours your raids on them carry double loot.`, { pactId: p.id, diplomacy: true, until: window.toISOString() });
  await tx.insert(events).values({ matchId: m.id, at: now, kind: "tribute.refused", payload: { from: p.bPlayerId, to: p.aPlayerId, expired } });
  if (refuser?.capital) {
    const [cap] = await tx.select().from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, refuser.capital))).limit(1);
    if (cap) {
      const b = balance.events.bounty;
      const amount: Record<string, number> = {};
      for (const [k, v] of Object.entries(stockOf(cap))) if (v * b.tributeShare >= 1) amount[k] = Math.floor(v * b.tributeShare);
      await placeBounty(tx, m, { kind: "player", playerId: p.bPlayerId, amount, reason: `${name} refused tribute`, hours: b.tributeHours }, now);
    }
  }
  return row!;
}

/** Run from the tick: expired demands become refusals (cause for war), ended pacts close, ceasefires run out. */
export async function expirePacts(tx: Tx, m: MatchRow, now: Date): Promise<void> {
  const d = balance.events.diplomacy;
  const due = await tx
    .select()
    .from(pacts)
    .where(and(eq(pacts.matchId, m.id), inArray(pacts.status, ["proposed", "active", "ending"]), lt(pacts.until, now)))
    .for("update");
  for (const p of due) {
    if (p.kind === "tribute" && p.status === "proposed") {
      await refuseTribute(tx, m, p, now, true);
    } else if (p.kind === "tribute") {
      await tx.update(pacts).set({ status: "ended" }).where(eq(pacts.id, p.id));
    } else {
      await tx.update(pacts).set({ status: "ended" }).where(eq(pacts.id, p.id));
      for (const pid of [p.aPlayerId, p.bPlayerId]) await notify(tx, m.id, pid, "alliance", `Your ${p.kind === "nap" ? "pact" : "ceasefire"} has ended.`, { pactId: p.id, diplomacy: true });
    }
  }
}
