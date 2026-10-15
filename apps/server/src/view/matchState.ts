import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { parseProfile } from "../sim/ai.js";
import { emptySpecial, regionById, type ArmyView, type IncomingView, type JobView, type MatchStateView, type OwnedRegionView, type SightedRegionView, techEffectsOf, allRegions } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { allianceMembers, alliances, armies, jobs, matchRegions, matches, playerTechs, players, regionSightings, tradeRoutes } from "../db/schema.js";
import { matchNow } from "../sim/clock.js";
import { alliesOf } from "../sim/alliances.js";
import { countOwnedRegions, projectRegion } from "../sim/regions.js";

/**
 * The only path from database to a player's screen. Everything a player can
 * see about a match goes through here, so fog of war is enforced in one place.
 */
export async function buildMatchState(db: Db, matchId: string, userId: string): Promise<MatchStateView | null> {
  const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!m) return null;
  const [me] = await db
    .select()
    .from(players)
    .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
    .limit(1);
  if (!me) return null;

  const now = matchNow(m);
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, me.id));
  const myTechFx = techEffectsOf(new Set(techRows.map((t) => t.id)));
  const ownedRows = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.ownerPlayerId, me.id)));

  const owned: OwnedRegionView[] = ownedRows.map((row) => {
    const { economy, rates, effects } = projectRegion(row, now, m.speed, myTechFx);
    return {
      regionId: row.regionId,
      ownerPlayerId: me.id,
      popWorkers: economy.popWorkers,
      popSoldiers: economy.popSoldiers,
      popOccupiers: economy.popOccupiers,
      food: economy.food,
      wood: economy.wood,
      stone: economy.stone,
      special: { ...emptySpecial(), ...economy.special },
      assignment: economy.assignment,
      storage: economy.storage,
      capacity: economy.capacity,
      yieldMult: economy.yieldMult,
      extract: economy.extract as Record<string, number>,
      buildings: row.buildings,
      units: row.units,
      effects: {
        defense: effects.defense,
        loyalty: effects.loyalty,
        researchSpeed: effects.researchSpeed,
        trainSpeed: effects.trainSpeed,
        protect: effects.protect,
        harbor: effects.harbor,
      },
      loyalty: row.loyalty,
      conquered: row.conquered,
      iceFactor: economy.iceFactor,
      growthMult: economy.growthMult,
      frozen: economy.frozen,
      evacuated: economy.abandoned,
      asOf: now.toISOString(),
      rates: { food: rates.food, wood: rates.wood, stone: rates.stone, population: rates.population, starving: rates.starving },
      isCapital: row.regionId === me.capitalRegionId,
    };
  });

  const sightRows = await db
    .select()
    .from(regionSightings)
    .where(and(eq(regionSightings.matchId, matchId), eq(regionSightings.playerId, me.id)));
  const sighted: SightedRegionView[] = sightRows.map((s) => {
    const snap = s.snapshot as { ownerPlayerId?: string | null; ownerName?: string | null; population?: number | null; buildings?: Record<string, number> };
    return {
      regionId: s.regionId,
      ownerPlayerId: snap.ownerPlayerId ?? null,
      ownerName: snap.ownerName ?? null,
      population: snap.population ?? null,
      seenAt: s.seenAt.toISOString(),
      roads: (snap.buildings?.roads ?? 0) >= 1,
    };
  });

  // Shared vision: allies' regions are always visible, as of now.
  const allies = await alliesOf(db, matchId, me.id);
  const [membership] = await db
    .select({ allianceId: alliances.id, tag: alliances.tag })
    .from(allianceMembers)
    .innerJoin(alliances, eq(alliances.id, allianceMembers.allianceId))
    .where(eq(allianceMembers.playerId, me.id))
    .limit(1);
  if (allies.length) {
    const allyRows = await db
      .select()
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, matchId), inArray(matchRegions.ownerPlayerId, allies)));
    const allyNames = new Map((await db.select({ id: players.id, name: players.name }).from(players).where(inArray(players.id, allies))).map((p) => [p.id, p.name]));
    const seen = new Set(sighted.map((s) => s.regionId));
    for (const row of allyRows) {
      const { economy } = projectRegion(row, now, m.speed);
      const view: SightedRegionView = {
        regionId: row.regionId,
        ownerPlayerId: row.ownerPlayerId,
        ownerName: row.ownerPlayerId ? (allyNames.get(row.ownerPlayerId) ?? null) : null,
        population: economy.popWorkers + economy.popSoldiers + economy.popOccupiers,
        seenAt: now.toISOString(),
        roads: ((row.buildings as Record<string, number>).roads ?? 0) >= 1,
      };
      if (seen.has(row.regionId)) {
        const i = sighted.findIndex((s) => s.regionId === row.regionId);
        sighted[i] = view;
      } else {
        sighted.push(view);
        seen.add(row.regionId);
      }
    }
  }

  // Radar and satellites: live sight of regions near (or everywhere beyond) my borders.
  if (myTechFx.vision > 0) {
    const mineIds = new Set(ownedRows.map((r) => r.regionId));
    let ring = new Set<string>(mineIds);
    const visible = new Set<string>();
    if (myTechFx.vision >= 99) {
      for (const r of allRegions()) if (!mineIds.has(r.id)) visible.add(r.id);
    } else {
      for (let i = 0; i < myTechFx.vision; i++) {
        const next = new Set<string>();
        for (const id of ring) for (const n of regionById(id)?.neighbors ?? []) if (!mineIds.has(n) && !visible.has(n)) { visible.add(n); next.add(n); }
        ring = next;
      }
    }
    if (visible.size) {
      const rows = await db
        .select()
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, matchId), inArray(matchRegions.regionId, [...visible])));
      const ownerIds = [...new Set(rows.map((r) => r.ownerPlayerId).filter((x): x is string => !!x))];
      const names = new Map(ownerIds.length ? (await db.select({ id: players.id, name: players.name }).from(players).where(inArray(players.id, ownerIds))).map((p) => [p.id, p.name]) : []);
      const seen = new Set(sighted.map((s) => s.regionId));
      for (const row of rows) {
        const { economy } = projectRegion(row, now, m.speed);
        const view: SightedRegionView = {
          regionId: row.regionId,
          ownerPlayerId: row.ownerPlayerId,
          ownerName: row.ownerPlayerId ? (names.get(row.ownerPlayerId) ?? null) : null,
          population: economy.popWorkers + economy.popSoldiers + economy.popOccupiers,
          seenAt: now.toISOString(),
          roads: ((row.buildings as Record<string, number>).roads ?? 0) >= 1,
        };
        const i = sighted.findIndex((s) => s.regionId === row.regionId);
        if (i >= 0) sighted[i] = view;
        else {
          sighted.push(view);
          seen.add(row.regionId);
        }
      }
      // Empty land in view is listed too, so it reads as explored.
      for (const id of visible) {
        if (seen.has(id)) continue;
        sighted.push({ regionId: id, ownerPlayerId: null, ownerName: null, population: 0, seenAt: now.toISOString(), roads: false });
        seen.add(id);
      }
    }
  }

  const ownedIds = ownedRows.map((r) => r.regionId);
  const jobRows = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.matchId, matchId),
        isNull(jobs.completedAt),
        isNull(jobs.cancelledAt),
        or(eq(jobs.playerId, me.id), ownedIds.length ? inArray(jobs.regionId, ownedIds) : eq(jobs.playerId, me.id)),
        inArray(jobs.kind, ["build", "train", "research"]),
      ),
    )
    .orderBy(asc(jobs.startsAt));
  const jobViews: JobView[] = jobRows.map((j) => ({
    id: j.id,
    kind: j.kind,
    regionId: j.regionId,
    refId: j.refId,
    level: j.level,
    qty: j.qty,
    startsAt: j.startsAt.toISOString(),
    endsAt: j.endsAt.toISOString(),
    waitingFor: j.waitingFor ?? null,
  }));

  const all = await db.select().from(players).where(eq(players.matchId, matchId)).orderBy(asc(players.createdAt), asc(players.id));
  const counts = await countOwnedRegions(db, matchId);
  const nameOf = new Map(all.map((p) => [p.id, p.name]));

  const myArmies = await db
    .select()
    .from(armies)
    .where(and(eq(armies.matchId, matchId), eq(armies.playerId, me.id), inArray(armies.status, ["outbound", "returning"])))
    .orderBy(asc(armies.arrivesAt));
  const armyViews: ArmyView[] = myArmies.map((a) => ({
    id: a.id,
    playerId: a.playerId,
    mission: a.mission,
    originRegionId: a.originRegionId,
    targetRegionId: a.targetRegionId,
    units: a.units,
    cargo: a.cargo,
    status: a.status,
    departsAt: a.departsAt.toISOString(),
    arrivesAt: a.arrivesAt.toISOString(),
    returnsAt: a.returnsAt?.toISOString() ?? null,
    path: a.path,
    note: a.note ?? null,
  }));

  const hostile = ownedIds.length
    ? await db
        .select()
        .from(armies)
        .where(and(eq(armies.matchId, matchId), eq(armies.status, "outbound"), inArray(armies.targetRegionId, ownedIds), inArray(armies.mission, ["raid", "conquer"])))
        .orderBy(asc(armies.arrivesAt))
    : [];
  // Frontier: empty, unclaimed regions bordering mine (settle targets). Reveals only that nobody lives there.
  const frontierIds = [...new Set(ownedIds.flatMap((id) => regionById(id)?.neighbors ?? []))].filter((id) => !ownedIds.includes(id));
  const frontierRows = frontierIds.length
    ? await db
        .select({ regionId: matchRegions.regionId, owner: matchRegions.ownerPlayerId, pop: sql<number>`${matchRegions.popWorkers} + ${matchRegions.popSoldiers} + ${matchRegions.popOccupiers}` })
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, matchId), inArray(matchRegions.regionId, frontierIds)))
    : [];
  const occupiedFrontier = new Set(frontierRows.filter((r) => r.owner || r.pop >= 1).map((r) => r.regionId));
  const frontier = frontierIds.filter((id) => !occupiedFrontier.has(id) && !regionById(id)?.terrain.startsWith("tundra"));

  const routeRows = await db.select().from(tradeRoutes).where(and(eq(tradeRoutes.matchId, matchId), eq(tradeRoutes.playerId, me.id))).orderBy(asc(tradeRoutes.createdAt));

  const incoming: IncomingView[] = hostile
    .filter((a) => a.playerId !== me.id)
    .map((a) => ({
      id: a.id,
      mission: a.mission,
      targetRegionId: a.targetRegionId,
      fromPlayerId: a.playerId,
      fromPlayerName: nameOf.get(a.playerId) ?? "Unknown",
      arrivesAt: a.arrivesAt.toISOString(),
      size: Object.values(a.units).reduce((x, y) => x + y, 0),
    }));

  return {
    match: {
      id: m.id,
      name: m.name,
      status: m.status,
      speed: m.speed,
      startsAt: m.startsAt.toISOString(),
      endsAt: m.endsAt.toISOString(),
      now: now.toISOString(),
      clockOffsetSeconds: m.clockOffsetSeconds,
    },
    me: {
      playerId: me.id,
      name: me.name,
      capitalRegionId: me.capitalRegionId,
      protectionUntil: me.protectionUntil?.toISOString() ?? null,
      age: me.age,
      techs: techRows.map((t) => t.id),
      allianceId: membership?.allianceId ?? null,
      allianceTag: membership?.tag ?? null,
    },
    owned,
    sighted,
    players: all.map((p) => ({ id: p.id, name: p.name, isAi: p.isAi, aiLevel: p.isAi ? parseProfile(p.aiProfile).difficulty : null, age: p.age, score: p.score, regions: counts.get(p.id) ?? 0 })),
    jobs: jobViews,
    armies: armyViews,
    incoming,
    frontier,
    routes: routeRows.map((r) => ({
      id: r.id,
      fromRegionId: r.fromRegionId,
      toRegionId: r.toRegionId,
      mode: r.mode,
      load: r.load,
      share: r.share,
      caravans: r.caravans,
      everyHours: r.everyHours,
      enabled: r.enabled,
      nextAt: r.nextAt.toISOString(),
      lastResult: r.lastResult,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      target: r.target ?? null,
      delivered: r.delivered,
    })),
    allies,
  };
}
