import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { allianceIdBody, allianceInviteBody, allianceKickBody, createAllianceBody, type AlliancesResponse, type AllianceView } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { allianceInvites, allianceMembers, alliances, matches, messages, players } from "../db/schema.js";
import { requireUser } from "../auth/session.js";
import type { Publisher } from "../realtime/publish.js";
import { httpError } from "../sim/commands.js";
import { countOwnedRegions, type Tx } from "../sim/regions.js";

type PlayerRow = typeof players.$inferSelect;

/** Alliances: create, invite, accept/decline, leave, kick, list. */
export async function allianceRoutes(app: FastifyInstance, opts: { db: Db; publisher: Publisher }) {
  const { db, publisher } = opts;

  async function myPlayer(matchId: string, userId: string): Promise<PlayerRow> {
    const [m] = await db.select({ id: matches.id }).from(matches).where(eq(matches.id, matchId)).limit(1);
    if (!m) throw httpError(404, "match not found");
    const [p] = await db
      .select()
      .from(players)
      .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
      .limit(1);
    if (!p) throw httpError(403, "not your match");
    return p;
  }

  async function membershipOf(tx: Tx | Db, playerId: string) {
    const [row] = await tx.select().from(allianceMembers).where(eq(allianceMembers.playerId, playerId)).limit(1);
    return row ?? null;
  }

  async function memberIds(tx: Tx | Db, allianceId: string): Promise<string[]> {
    const rows = await tx.select({ playerId: allianceMembers.playerId }).from(allianceMembers).where(eq(allianceMembers.allianceId, allianceId));
    return rows.map((r) => r.playerId);
  }

  async function notify(tx: Tx | Db, matchId: string, playerId: string, subject: string, payload: Record<string, unknown>) {
    await tx.insert(messages).values({ matchId, playerId, kind: "alliance", subject, payload });
  }

  async function publishToMembers(matchId: string, ids: string[], payload: Record<string, unknown>) {
    for (const id of ids) await publisher.toPlayer(matchId, id, "alliance.updated", payload);
  }

  app.post("/api/matches/:id/alliances", async (req, reply) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const body = createAllianceBody.parse(req.body);
    const p = await myPlayer(matchId, user.id);

    const created = await db.transaction(async (tx) => {
      if (await membershipOf(tx, p.id)) throw httpError(409, "you are already in an alliance");
      const [clash] = await tx
        .select({ id: alliances.id })
        .from(alliances)
        .where(and(eq(alliances.matchId, matchId), eq(alliances.tag, body.tag)))
        .limit(1);
      if (clash) throw httpError(409, "that tag is taken");
      const [a] = await tx.insert(alliances).values({ matchId, name: body.name, tag: body.tag, leaderPlayerId: p.id }).returning();
      if (!a) throw new Error("alliance insert failed");
      await tx.insert(allianceMembers).values({ matchId, allianceId: a.id, playerId: p.id, role: "leader" });
      await tx.delete(allianceInvites).where(eq(allianceInvites.playerId, p.id));
      return a;
    });
    await publisher.toMatch(matchId, "alliance.updated", { allianceId: created.id, action: "created" });
    return reply.code(201).send({ id: created.id, name: created.name, tag: created.tag });
  });

  app.post("/api/matches/:id/alliances/invite", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const body = allianceInviteBody.parse(req.body);
    const p = await myPlayer(matchId, user.id);

    const allianceId = await db.transaction(async (tx) => {
      const mine = await membershipOf(tx, p.id);
      if (!mine) throw httpError(409, "you are not in an alliance");
      if (mine.role !== "leader" && mine.role !== "officer") throw httpError(403, "only the leader or an officer can invite");
      const [target] = await tx
        .select()
        .from(players)
        .where(and(eq(players.matchId, matchId), eq(players.id, body.playerId)))
        .limit(1);
      if (!target) throw httpError(404, "player not found");
      if (target.isAi) throw httpError(400, "AI tribes do not join alliances");
      if (target.id === p.id) throw httpError(400, "you cannot invite yourself");
      if (await membershipOf(tx, target.id)) throw httpError(409, "that player is already in an alliance");
      const [a] = await tx.select().from(alliances).where(eq(alliances.id, mine.allianceId)).limit(1);
      if (!a) throw httpError(404, "alliance not found");
      await tx
        .insert(allianceInvites)
        .values({ matchId, allianceId: mine.allianceId, playerId: target.id })
        .onConflictDoNothing();
      await notify(tx, matchId, target.id, `${p.name} invited you to join [${a.tag}] ${a.name}`, { allianceId: a.id, tag: a.tag, name: a.name, from: p.name });
      return mine.allianceId;
    });
    await publisher.toPlayer(matchId, body.playerId, "alliance.updated", { allianceId, action: "invited" });
    await publisher.toPlayer(matchId, body.playerId, "message.new", {});
    return { ok: true };
  });

  app.post("/api/matches/:id/alliances/accept", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const body = allianceIdBody.parse(req.body);
    const p = await myPlayer(matchId, user.id);

    const members = await db.transaction(async (tx) => {
      if (await membershipOf(tx, p.id)) throw httpError(409, "you are already in an alliance");
      const [inv] = await tx
        .select()
        .from(allianceInvites)
        .where(and(eq(allianceInvites.allianceId, body.allianceId), eq(allianceInvites.playerId, p.id)))
        .limit(1);
      if (!inv) throw httpError(404, "no such invite");
      const [a] = await tx.select().from(alliances).where(eq(alliances.id, body.allianceId)).limit(1);
      if (!a) throw httpError(404, "alliance not found");
      await tx.insert(allianceMembers).values({ matchId, allianceId: a.id, playerId: p.id, role: "member" });
      await tx.delete(allianceInvites).where(eq(allianceInvites.playerId, p.id));
      const ids = await memberIds(tx, a.id);
      for (const id of ids) if (id !== p.id) await notify(tx, matchId, id, `${p.name} joined [${a.tag}] ${a.name}`, { allianceId: a.id, playerId: p.id });
      return ids;
    });
    await publishToMembers(matchId, members, { allianceId: body.allianceId, action: "joined", playerId: p.id });
    return { ok: true };
  });

  app.post("/api/matches/:id/alliances/decline", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const body = allianceIdBody.parse(req.body);
    const p = await myPlayer(matchId, user.id);
    await db.delete(allianceInvites).where(and(eq(allianceInvites.allianceId, body.allianceId), eq(allianceInvites.playerId, p.id)));
    await publisher.toPlayer(matchId, p.id, "alliance.updated", { allianceId: body.allianceId, action: "declined" });
    return { ok: true };
  });

  app.post("/api/matches/:id/alliances/leave", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const p = await myPlayer(matchId, user.id);

    const result = await db.transaction(async (tx) => {
      const mine = await membershipOf(tx, p.id);
      if (!mine) throw httpError(409, "you are not in an alliance");
      const [a] = await tx.select().from(alliances).where(eq(alliances.id, mine.allianceId)).limit(1);
      if (!a) throw httpError(404, "alliance not found");
      await tx.delete(allianceMembers).where(eq(allianceMembers.playerId, p.id));
      const rest = await tx
        .select()
        .from(allianceMembers)
        .where(eq(allianceMembers.allianceId, a.id))
        .orderBy(asc(allianceMembers.joinedAt), asc(allianceMembers.playerId));
      if (rest.length === 0) {
        await tx.delete(alliances).where(eq(alliances.id, a.id));
        return { allianceId: a.id, dissolved: true, members: [] as string[] };
      }
      if (mine.role === "leader") {
        const heir = rest[0]!;
        await tx.update(alliances).set({ leaderPlayerId: heir.playerId }).where(eq(alliances.id, a.id));
        await tx.update(allianceMembers).set({ role: "leader" }).where(eq(allianceMembers.playerId, heir.playerId));
        await notify(tx, matchId, heir.playerId, `You now lead [${a.tag}] ${a.name}`, { allianceId: a.id });
      }
      for (const r of rest) await notify(tx, matchId, r.playerId, `${p.name} left [${a.tag}] ${a.name}`, { allianceId: a.id, playerId: p.id });
      return { allianceId: a.id, dissolved: false, members: rest.map((r) => r.playerId) };
    });
    await publisher.toPlayer(matchId, p.id, "alliance.updated", { allianceId: result.allianceId, action: "left" });
    if (result.dissolved) await publisher.toMatch(matchId, "alliance.updated", { allianceId: result.allianceId, action: "dissolved" });
    else await publishToMembers(matchId, result.members, { allianceId: result.allianceId, action: "left", playerId: p.id });
    return { ok: true, dissolved: result.dissolved };
  });

  app.post("/api/matches/:id/alliances/kick", async (req) => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const body = allianceKickBody.parse(req.body);
    const p = await myPlayer(matchId, user.id);

    const members = await db.transaction(async (tx) => {
      const mine = await membershipOf(tx, p.id);
      if (!mine) throw httpError(409, "you are not in an alliance");
      if (mine.role !== "leader") throw httpError(403, "only the leader can kick");
      if (body.playerId === p.id) throw httpError(400, "leave instead of kicking yourself");
      const theirs = await membershipOf(tx, body.playerId);
      if (!theirs || theirs.allianceId !== mine.allianceId) throw httpError(404, "that player is not in your alliance");
      const [a] = await tx.select().from(alliances).where(eq(alliances.id, mine.allianceId)).limit(1);
      await tx.delete(allianceMembers).where(eq(allianceMembers.playerId, body.playerId));
      if (a) await notify(tx, matchId, body.playerId, `You were removed from [${a.tag}] ${a.name}`, { allianceId: a.id });
      return [...(await memberIds(tx, mine.allianceId)), body.playerId];
    });
    await publishToMembers(matchId, members, { action: "kicked", playerId: body.playerId });
    return { ok: true };
  });

  app.get("/api/matches/:id/alliances", async (req): Promise<AlliancesResponse> => {
    const user = requireUser(req);
    const matchId = (req.params as { id: string }).id;
    const p = await myPlayer(matchId, user.id);

    const rows = await db.select().from(alliances).where(eq(alliances.matchId, matchId)).orderBy(asc(alliances.createdAt));
    const ids = rows.map((r) => r.id);
    const memberRows = ids.length
      ? await db
          .select({ allianceId: allianceMembers.allianceId, playerId: allianceMembers.playerId, role: allianceMembers.role, joinedAt: allianceMembers.joinedAt, name: players.name })
          .from(allianceMembers)
          .innerJoin(players, eq(players.id, allianceMembers.playerId))
          .where(inArray(allianceMembers.allianceId, ids))
          .orderBy(asc(allianceMembers.joinedAt))
      : [];
    const counts = await countOwnedRegions(db, matchId);

    const views: AllianceView[] = rows.map((a) => {
      const members = memberRows
        .filter((m) => m.allianceId === a.id)
        .map((m) => ({ playerId: m.playerId, name: m.name, role: m.role, regions: counts.get(m.playerId) ?? 0, joinedAt: m.joinedAt.toISOString() }));
      return { id: a.id, name: a.name, tag: a.tag, leaderPlayerId: a.leaderPlayerId, members, regions: members.reduce((n, m) => n + m.regions, 0) };
    });
    const myMembership = memberRows.find((m) => m.playerId === p.id) ?? null;
    const mine = myMembership ? (views.find((v) => v.id === myMembership.allianceId) ?? null) : null;

    const inviteRows = await db
      .select({ id: allianceInvites.id, allianceId: allianceInvites.allianceId, name: alliances.name, tag: alliances.tag, createdAt: allianceInvites.createdAt })
      .from(allianceInvites)
      .innerJoin(alliances, eq(alliances.id, allianceInvites.allianceId))
      .where(eq(allianceInvites.playerId, p.id));

    return {
      alliances: views,
      mine,
      myRole: myMembership?.role ?? null,
      invites: mine ? [] : inviteRows.map((i) => ({ id: i.id, allianceId: i.allianceId, name: i.name, tag: i.tag, createdAt: i.createdAt.toISOString() })),
    };
  });
}
