import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { AGES, buildingById, regionById, type AgeIndex } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { events, matches, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import { httpError } from "../sim/commands.js";
import { idParams } from "./params.js";
import { milestoneLabel } from "../sim/endgame.js";

/** Event kinds everyone in the match may read, and how each reads as a line of the ticker. */
export const PUBLIC_KINDS = [
  "match.started", "ice.advanced", "age.advanced", "milestone", "wonder.started", "win.hold.started", "win.hold.cancelled", "match.finished", "player.eliminated",
  "storm.warning", "storm.hit", "thaw.pocket", "plague.outbreak", "refugees.arrived", "refugees.lost", "horde.sighted", "boom.found",
  "expedition.returned", "pact.made", "pact.ending", "tribute.paid", "tribute.refused", "bounty.placed", "bounty.claimed", "objective.won", "mercenaries.hired", "last.stand",
] as const;

export function feedText(kind: string, p: Record<string, unknown>, nameOf: (id: unknown) => string): string {
  const region = (id: unknown) => regionById(String(id ?? ""))?.name ?? String(id ?? "somewhere");
  switch (kind) {
    case "match.started": return "The match has begun. Thirty days until the ice stops.";
    case "ice.advanced": {
      const names = ((p.regions as string[] | undefined) ?? []).map(region);
      return names.length ? `The ice has taken ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}.` : `Day ${p.day}: the ice reaches ${Math.round(Number(p.latitude))}°.`;
    }
    case "age.advanced": return `${nameOf(p.playerId)} has entered the ${AGES[p.age as AgeIndex] ?? ""} Age.`;
    case "milestone": return `${milestoneLabel(String(p.key))}: ${nameOf(p.playerId)}.`;
    case "wonder.started": return `${nameOf(p.playerId)} has begun the ${buildingById.get("great_hearth")?.name ?? "Great Hearth"} in ${region(p.regionId)}.`;
    case "win.hold.started": return `${p.kind === "alliance" ? "An alliance" : nameOf(p.id)} holds ${p.regions} regions: the match ends in two days unless they are pushed back.`;
    case "win.hold.cancelled": return "The hold on the world is broken.";
    case "match.finished": return `The match is over. ${nameOf(p.winnerPlayerId)} wins.`;
    case "player.eliminated": return `${nameOf(p.playerId)} is out of the match.`;
    case "storm.warning": return `A blizzard gathers over ${region(p.centre)}: ${p.regions} regions will be in it by tomorrow.`;
    case "storm.hit": return `The blizzard over ${region(p.centre)} is blowing: half production, double travel across ${p.regions} regions.`;
    case "thaw.pocket": return `A warm pocket lingers over ${region(p.regionId)}; the ice passes it by for now.`;
    case "plague.outbreak": return `Sickness in ${region(p.regionId)} (${nameOf(p.playerId)}).`;
    case "refugees.arrived": return `${p.people} people fleeing ${region(p.fromRegionId)} have reached ${region(p.regionId)}.`;
    case "refugees.lost": return `A column of ${p.people} fleeing ${region(p.fromRegionId)} was lost to the ice.`;
    case "horde.sighted": return `The Northern Horde marches from ${region(p.camp)} on ${region(p.regionId)} (${nameOf(p.playerId)}).`;
    case "boom.found": return `A rich vein of ${p.resource} in ${region(p.regionId)} (${nameOf(p.playerId)}).`;
    case "expedition.returned": return `${nameOf(p.playerId)}'s expedition to ${region(p.regionId)} ${p.outcome}.`;
    case "pact.made": return `${nameOf(p.a)} and ${nameOf(p.b)} have agreed a ${p.kind === "ceasefire" ? "ceasefire" : "non-aggression pact"}.`;
    case "pact.ending": return `${nameOf(p.by)} has given notice: the pact with ${nameOf(p.other)} ends in a day.`;
    case "tribute.paid": return `${nameOf(p.from)} paid tribute to ${nameOf(p.to)}.`;
    case "tribute.refused": return `${nameOf(p.from)} refused tribute to ${nameOf(p.to)}. There is cause for war.`;
    case "bounty.placed": return `A bounty is placed on ${p.regionId ? region(p.regionId) : nameOf(p.playerId)}: ${p.reason}.`;
    case "bounty.claimed": return `${nameOf(p.by)} claimed the bounty on ${p.regionId ? region(p.regionId) : nameOf(p.playerId)}.`;
    case "objective.won": return `Day ${p.day}'s objective (${p.label}) goes to ${nameOf(p.playerId)}.`;
    case "mercenaries.hired": return `${nameOf(p.playerId)} has hired ${p.company}.`;
    case "last.stand": return `${nameOf(p.playerId)} makes a last stand: everything marches south to ${region(p.regionId)}.`;
    default: return kind;
  }
}

/** The ticker: the last public events of a match, newest first. Members while it runs; everyone once it is over. */
export async function feedRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.get("/api/matches/:id/feed", async (req, reply) => {
    const matchId = idParams.parse(req.params).id;
    const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) return reply.code(404).send({ error: "match not found" });
    if (m.status !== "finished") {
      const user = requireUser(req);
      const [p] = await db.select({ id: players.id }).from(players).where(and(eq(players.matchId, matchId), eq(players.userId, user.id))).limit(1);
      if (!p && !user.isAdmin) throw httpError(403, "only players in this match can read its feed while it runs");
    }
    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.matchId, matchId), inArray(events.kind, [...PUBLIC_KINDS])))
      .orderBy(desc(events.at))
      .limit(40);
    const ps = await db.select({ id: players.id, name: players.name }).from(players).where(eq(players.matchId, matchId));
    const names = new Map(ps.map((p) => [p.id, p.name]));
    const nameOf = (id: unknown) => (typeof id === "string" ? (names.get(id) ?? "someone") : "someone");
    return {
      items: rows.map((e) => {
        const p = e.payload as Record<string, unknown>;
        return { id: e.id, at: e.at.toISOString(), kind: e.kind, text: feedText(e.kind, p, nameOf), regionId: (p.regionId as string | undefined) ?? null, playerId: (p.playerId as string | undefined) ?? null };
      }),
    };
  });
}
