import { and, asc, eq, inArray, isNull, or, sql, gt } from "drizzle-orm";
import { parseProfile } from "../sim/ai.js";
import { emptySpecial, regionById, type ArmyView, type IncomingView, type JobView, type MatchStateView, type OwnedRegionView, type SightedRegionView, type LiveBattleView, techEffectsOf, allRegions, wallOf, balance, freezeDayForLatitude, legIndex, advisorReport, campaignView } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { allianceMembers, alliances, armies, jobs, matchRegions, matches, playerTechs, players, regionSightings, tradeRoutes, refugeeOffers, pacts, mercenaryOffers, dailyObjectives, bounties, regionNotes, advisors, battles } from "../db/schema.js";
import { OBJECTIVES } from "../sim/objectives.js";
import { matchNow, matchDayAt } from "../sim/clock.js";
import { alliesOf } from "../sim/alliances.js";
import { countOwnedRegions, projectRegion, resourceMultOf } from "../sim/regions.js";
import { parseSettings, wageFor } from "../sim/advisors.js";
import { liveBattleOf } from "../matches/battlesApi.js";

/** Battles playing out in the match right now, for the map's crossed swords. */
async function liveBattles(db: Db, matchId: string): Promise<LiveBattleView[]> {
  const rows = await db.select().from(battles).where(and(eq(battles.matchId, matchId), eq(battles.status, "fighting")));
  if (!rows.length) return [];
  const names = new Map((await db.select({ id: players.id, name: players.name }).from(players).where(eq(players.matchId, matchId))).map((p) => [p.id, p.name]));
  return rows.map((b) => liveBattleOf(b, names));
}

/**
 * The only path from database to a player's screen. Everything a player can
 * see about a match goes through here, so fog of war is enforced in one place.
 */
export async function buildMatchState(db: Db, matchId: string, userId: string, opts: { observer?: boolean } = {}): Promise<MatchStateView | null> {
  const [m] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1);
  if (!m) return null;
  const [me] = await db
    .select()
    .from(players)
    .where(and(eq(players.matchId, matchId), eq(players.userId, userId)))
    .limit(1);
  if (!me) return opts.observer ? buildObserverState(db, m, matchId) : null;

  const now = matchNow(m);
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, me.id));
  const myTechFx = techEffectsOf(new Set(techRows.map((t) => t.id)));
  const ownedRows = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, matchId), eq(matchRegions.ownerPlayerId, me.id)));

  const owned: OwnedRegionView[] = ownedRows.map((row) => {
    const { economy, rates, effects } = projectRegion(row, now, m.speed, myTechFx, resourceMultOf(m));
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
      stormUntil: economy.storm ? row.stormUntil!.toISOString() : null,
      plagueUntil: economy.plague ? row.plagueUntil!.toISOString() : null,
      thawUntil: row.thawUntil && row.thawUntil > now ? row.thawUntil.toISOString() : null,
      boom: economy.boom && row.boom ? { resource: row.boom.resource, until: row.boom.until } : null,
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
      wall: wallOf(snap.buildings),
      storm: false,
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
      const { economy } = projectRegion(row, now, m.speed, undefined, resourceMultOf(m));
      const view: SightedRegionView = {
        regionId: row.regionId,
        ownerPlayerId: row.ownerPlayerId,
        ownerName: row.ownerPlayerId ? (allyNames.get(row.ownerPlayerId) ?? null) : null,
        population: economy.popWorkers + economy.popSoldiers + economy.popOccupiers,
        seenAt: now.toISOString(),
        roads: ((row.buildings as Record<string, number>).roads ?? 0) >= 1,
        wall: wallOf(row.buildings as Record<string, number>),
        storm: false,
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

  // Watchtowers: every region next to a tower of mine is in plain view, units and all, as of now.
  {
    const mineIds = new Set(ownedRows.map((r) => r.regionId));
    const watched = new Set<string>();
    for (const r of ownedRows) if ((r.buildings.watchtower ?? 0) >= 1) for (const n of regionById(r.regionId)?.neighbors ?? []) if (!mineIds.has(n)) watched.add(n);
    if (watched.size) {
      const rows = await db
        .select()
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, matchId), inArray(matchRegions.regionId, [...watched])));
      const ownerIds = [...new Set(rows.map((r) => r.ownerPlayerId).filter((x): x is string => !!x))];
      const names = new Map(ownerIds.length ? (await db.select({ id: players.id, name: players.name }).from(players).where(inArray(players.id, ownerIds))).map((p) => [p.id, p.name]) : []);
      for (const row of rows) {
        const { economy } = projectRegion(row, now, m.speed, undefined, resourceMultOf(m));
        const units = Object.fromEntries(Object.entries(row.units as Record<string, number>).filter(([, n]) => n > 0));
        const view: SightedRegionView = {
          regionId: row.regionId,
          ownerPlayerId: row.ownerPlayerId,
          ownerName: row.ownerPlayerId ? (names.get(row.ownerPlayerId) ?? null) : null,
          population: economy.popWorkers + economy.popSoldiers + economy.popOccupiers,
          seenAt: now.toISOString(),
          roads: ((row.buildings as Record<string, number>).roads ?? 0) >= 1,
          wall: wallOf(row.buildings as Record<string, number>),
          storm: false,
          units,
        };
        const i = sighted.findIndex((s) => s.regionId === row.regionId);
        if (i >= 0) sighted[i] = view;
        else sighted.push(view);
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
        const { economy } = projectRegion(row, now, m.speed, undefined, resourceMultOf(m));
        const view: SightedRegionView = {
          regionId: row.regionId,
          ownerPlayerId: row.ownerPlayerId,
          ownerName: row.ownerPlayerId ? (names.get(row.ownerPlayerId) ?? null) : null,
          population: economy.popWorkers + economy.popSoldiers + economy.popOccupiers,
          seenAt: now.toISOString(),
          roads: ((row.buildings as Record<string, number>).roads ?? 0) >= 1,
          wall: wallOf(row.buildings as Record<string, number>),
          storm: false,
        };
        const i = sighted.findIndex((s) => s.regionId === row.regionId);
        if (i >= 0) sighted[i] = { ...view, ...(sighted[i]!.units ? { units: sighted[i]!.units } : {}) };
        else {
          sighted.push(view);
          seen.add(row.regionId);
        }
      }
      // Empty land in view is listed too, so it reads as explored.
      for (const id of visible) {
        if (seen.has(id)) continue;
        sighted.push({ regionId: id, ownerPlayerId: null, ownerName: null, population: 0, seenAt: now.toISOString(), roads: false, wall: null, storm: false });
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

  const all = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, false))).orderBy(asc(players.createdAt), asc(players.id));
  const counts = await countOwnedRegions(db, matchId);
  const nameOf = new Map(all.map((p) => [p.id, p.name]));

  const myArmies = await db
    .select()
    .from(armies)
    .where(and(eq(armies.matchId, matchId), eq(armies.playerId, me.id), inArray(armies.status, ["outbound", "returning", "fighting"])))
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
    lane: a.lane ?? null,
    stops: a.stops,
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
  // Weather and thaw pockets are common knowledge; migrant columns are mine alone.
  const stormRows = await db.select({ regionId: matchRegions.regionId }).from(matchRegions).where(and(eq(matchRegions.matchId, matchId), gt(matchRegions.stormUntil, now)));
  const thawRows = await db.select({ regionId: matchRegions.regionId, thawUntil: matchRegions.thawUntil }).from(matchRegions).where(and(eq(matchRegions.matchId, matchId), gt(matchRegions.thawUntil, now)));
  const noteRows = await db.select().from(regionNotes).where(and(eq(regionNotes.matchId, matchId), eq(regionNotes.playerId, me.id)));
  const offerRows = await db.select().from(refugeeOffers).where(and(eq(refugeeOffers.playerId, me.id), isNull(refugeeOffers.decidedAt), gt(refugeeOffers.expiresAt, now))).orderBy(asc(refugeeOffers.expiresAt));
  const pactRows = await db
    .select()
    .from(pacts)
    .where(and(eq(pacts.matchId, matchId), or(eq(pacts.aPlayerId, me.id), eq(pacts.bPlayerId, me.id)), inArray(pacts.status, ["proposed", "active", "ending", "refused"])))
    .orderBy(asc(pacts.createdAt));
  const advisorRows = await db.select().from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, me.id), isNull(advisors.firedAt)));
  // Advisors fired within the cooldown, and when each will take the player back.
  const firedRows = await db.select({ kind: advisors.kind, firedAt: advisors.firedAt }).from(advisors).where(and(eq(advisors.matchId, matchId), eq(advisors.playerId, me.id), sql`${advisors.firedAt} is not null`));
  const rehireAt: Record<string, string> = {};
  for (const r of firedRows) {
    const back = new Date(r.firedAt!.getTime() + (balance.advisors.rehireCooldownHours * 3600_000) / m.speed);
    if (back > now && (!rehireAt[r.kind] || Date.parse(rehireAt[r.kind]!) < back.getTime())) rehireAt[r.kind] = back.toISOString();
  }
  const advisorWage = await wageFor(db, m, me.id);
  const mercRows = await db.select().from(mercenaryOffers).where(and(eq(mercenaryOffers.matchId, matchId), isNull(mercenaryOffers.hiredBy), gt(mercenaryOffers.expiresAt, now))).orderBy(asc(mercenaryOffers.expiresAt));
  const capLat = me.capitalRegionId ? Math.abs(regionById(me.capitalRegionId)?.lat ?? 0) : 0;
  const matchDayNow = ((now.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed;
  const dayIdx = Math.max(0, Math.floor(matchDayNow));
  const objRows = await db.select().from(dailyObjectives).where(and(eq(dailyObjectives.matchId, matchId), inArray(dailyObjectives.day, [dayIdx, dayIdx - 1])));
  const today = objRows.find((o) => o.day === dayIdx);
  const yday = objRows.find((o) => o.day === dayIdx - 1);
  const objective = today ? { day: today.day + 1, label: OBJECTIVES[today.key] ?? today.key, yesterday: yday ? { label: OBJECTIVES[yday.key] ?? yday.key, playerId: yday.winnerPlayerId, value: yday.value ?? 0 } : null } : null;
  const bountyRows = await db.select().from(bounties).where(and(eq(bounties.matchId, matchId), isNull(bounties.claimedBy), or(isNull(bounties.expiresAt), gt(bounties.expiresAt, now)))).orderBy(asc(bounties.createdAt));
  const lastStandEligible = !!me.capitalRegionId && !me.lastStandAt && (freezeDayForLatitude(capLat) ?? 999) - matchDayNow <= balance.events.lastStand.withinDays;
  const stormSet = new Set(stormRows.map((r) => r.regionId));
  for (const s of sighted) s.storm = stormSet.has(s.regionId);

  // Watchtowers: once an attacking force is on its last leg, coming out of a region next to the target, a tower on the
  // target or on any region of mine beside it sees exactly what is coming.
  const towers = new Set(ownedRows.filter((r) => (r.buildings.watchtower ?? 0) >= 1).map((r) => r.regionId));
  const seenBy = (targetId: string, a: { path: string[]; departsAt: Date; arrivesAt: Date }) => {
    if (towers.size === 0) return false;
    const neighbours = regionById(targetId)?.neighbors ?? [];
    if (!towers.has(targetId) && !neighbours.some((n) => towers.has(n))) return false;
    const path = a.path.length >= 2 ? a.path : [targetId, targetId];
    return legIndex(path.length, a.departsAt.getTime(), a.arrivesAt.getTime(), now.getTime()) >= path.length - 2;
  };
  const incoming: IncomingView[] = hostile
    .filter((a) => a.playerId !== me.id)
    .map((a) => ({
      id: a.id,
      mission: a.mission,
      targetRegionId: a.targetRegionId,
      fromPlayerId: a.playerId,
      fromPlayerName: nameOf.get(a.playerId) ?? "Unknown",
      arrivesAt: a.arrivesAt.toISOString(),
      // A band, not the exact count: scouts, walls and watchtowers are what tell you more.
      size: roundBand(Object.values(a.units).reduce((x, y) => x + y, 0)),
      ...(seenBy(a.targetRegionId, a) ? { units: a.units } : {}),
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
      pausedAt: m.pausedAt?.toISOString() ?? null,
      slug: m.slug ?? m.id,
      finishedAt: m.finishedAt?.toISOString() ?? null,
      winnerPlayerId: m.winnerPlayerId ?? null,
      createdByMe: !!me.userId && ((m.settings ?? {}) as { createdBy?: string }).createdBy === me.userId,
      tournament: ((m.settings ?? {}) as { kind?: string }).kind === "tournament",
      resourceMult: resourceMultOf(m),
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
    storms: stormRows.map((r) => r.regionId),
    thaws: thawRows.map((r) => ({ regionId: r.regionId, until: r.thawUntil!.toISOString() })),
    refugees: offerRows.map((o) => ({ id: o.id, regionId: o.regionId, fromRegionId: o.fromRegionId, people: o.people, food: o.people * balance.events.refugees.foodPerPerson, expiresAt: o.expiresAt.toISOString() })),
    pacts: pactRows.map((p) => ({ id: p.id, kind: p.kind as "nap" | "ceasefire" | "tribute", aPlayerId: p.aPlayerId, bPlayerId: p.bPlayerId, status: p.status, until: p.until?.toISOString() ?? null, terms: (p.terms ?? {}) as Record<string, unknown> })),
    mercenaries: mercRows.map((o) => ({ id: o.id, company: o.company, unitId: o.unitId, qty: o.qty, iron: o.iron, expiresAt: o.expiresAt.toISOString() })),
    advisorWage,
    rehireAt,
    battles: await liveBattles(db, matchId),
    advisors: advisorRows.map((a) => ({
      kind: a.kind,
      hiredAt: a.hiredAt.toISOString(),
      paidUntil: a.paidUntil.toISOString(),
      unpaid: a.unpaidSince !== null,
      wage: advisorWage,
      // A target you already own is never shown, whatever the row still says: the ⚔ goes the moment the region is yours.
      settings: ((s) => ({ ...s, targets: s.targets.filter((t) => !ownedIds.includes(t)) }))(parseSettings(a.settings)),
      lastPassAt: a.lastPassAt?.toISOString() ?? null,
      lastReport: a.lastReport ? advisorReport.parse(a.lastReport) : null,
      campaigns: campaignView.array().parse(a.campaigns ?? []),
    })),
    lastStand: { eligible: lastStandEligible, used: !!me.lastStandAt },
    objective,
    bounties: bountyRows.map((b) => ({ id: b.id, kind: b.kind as "region" | "player", regionId: b.regionId, playerId: b.playerId, amount: b.amount, reason: b.reason, expiresAt: b.expiresAt?.toISOString() ?? null })),
    notes: noteRows.map((n) => ({ regionId: n.regionId, text: n.text, colour: n.colour as "red" | "amber" | "green" | "blue" | "purple" | null, updatedAt: n.updatedAt.toISOString() })),
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
      held: r.held,
    })),
    allies,
    observer: false,
  };
}

/** 1-9 as is, then to the nearest 5, 10, 50 and 100 as the number grows. */
function roundBand(n: number): number {
  const step = n < 10 ? 1 : n < 50 ? 5 : n < 200 ? 10 : n < 1000 ? 50 : 100;
  return Math.max(1, Math.round(n / step) * step);
}

/**
 * God mode for an admin who is not a player: every claimed region with its people, buildings and units as of now,
 * every army on the road, every march against anyone, the standings and the world's state. Nothing can be done
 * from it; the page shows it read-only.
 */
async function buildObserverState(db: Db, m: typeof matches.$inferSelect, matchId: string): Promise<MatchStateView> {
  const now = matchNow(m);
  const all = await db.select().from(players).where(and(eq(players.matchId, matchId), eq(players.hidden, false))).orderBy(asc(players.createdAt), asc(players.id));
  const nameOf = new Map(all.map((p) => [p.id, p.name]));
  const counts = await countOwnedRegions(db, matchId);
  const rows = await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, matchId), sql`${matchRegions.ownerPlayerId} is not null`));
  const sighted: SightedRegionView[] = rows.map((row) => {
    const { economy } = projectRegion(row, now, m.speed, undefined, resourceMultOf(m));
    return {
      regionId: row.regionId,
      ownerPlayerId: row.ownerPlayerId,
      ownerName: row.ownerPlayerId ? (nameOf.get(row.ownerPlayerId) ?? null) : null,
      population: economy.popWorkers + economy.popSoldiers + economy.popOccupiers,
      seenAt: now.toISOString(),
      roads: ((row.buildings as Record<string, number>).roads ?? 0) >= 1,
      wall: wallOf(row.buildings as Record<string, number>),
      storm: !!row.stormUntil && row.stormUntil > now,
      units: Object.fromEntries(Object.entries(row.units as Record<string, number>).filter(([, n]) => n > 0)),
    };
  });
  const inFlight = await db
    .select()
    .from(armies)
    .where(and(eq(armies.matchId, matchId), inArray(armies.status, ["outbound", "returning", "fighting"])))
    .orderBy(asc(armies.arrivesAt));
  const armyViews: ArmyView[] = inFlight.map((a) => ({
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
    lane: a.lane ?? null,
    stops: a.stops,
  }));
  const incoming: IncomingView[] = inFlight
    .filter((a) => a.status === "outbound" && (a.mission === "raid" || a.mission === "conquer"))
    .map((a) => ({
      id: a.id,
      mission: a.mission,
      targetRegionId: a.targetRegionId,
      fromPlayerId: a.playerId,
      fromPlayerName: nameOf.get(a.playerId) ?? "Unknown",
      arrivesAt: a.arrivesAt.toISOString(),
      size: Object.values(a.units).reduce((x, y) => x + y, 0),
      units: a.units,
    }));
  const stormRows = rows.filter((r) => r.stormUntil && r.stormUntil > now);
  const thawRows = rows.filter((r) => r.thawUntil && r.thawUntil > now);
  const bountyRows = await db.select().from(bounties).where(and(eq(bounties.matchId, matchId), isNull(bounties.claimedBy), or(isNull(bounties.expiresAt), gt(bounties.expiresAt, now)))).orderBy(asc(bounties.createdAt));
  const dayIdx = Math.floor(matchDayAt(m, now));
  const objRows = await db.select().from(dailyObjectives).where(and(eq(dailyObjectives.matchId, matchId), inArray(dailyObjectives.day, [dayIdx, dayIdx - 1])));
  const today = objRows.find((o) => o.day === dayIdx);
  const yday = objRows.find((o) => o.day === dayIdx - 1);
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
      pausedAt: m.pausedAt?.toISOString() ?? null,
      slug: m.slug ?? "",
      finishedAt: m.finishedAt?.toISOString() ?? null,
      winnerPlayerId: m.winnerPlayerId ?? null,
      createdByMe: false,
      tournament: ((m.settings ?? {}) as { kind?: string }).kind === "tournament",
      resourceMult: resourceMultOf(m),
    },
    me: { playerId: "", name: "Admin view", capitalRegionId: null, protectionUntil: null, age: 0, techs: [], allianceId: null, allianceTag: null },
    owned: [],
    sighted,
    players: all.map((p) => ({ id: p.id, name: p.name, isAi: p.isAi, aiLevel: p.isAi ? parseProfile(p.aiProfile).difficulty : null, age: p.age, score: p.score, regions: counts.get(p.id) ?? 0 })),
    jobs: [],
    armies: armyViews,
    incoming,
    frontier: [],
    storms: stormRows.map((r) => r.regionId),
    thaws: thawRows.map((r) => ({ regionId: r.regionId, until: r.thawUntil!.toISOString() })),
    refugees: [],
    pacts: [],
    mercenaries: [],
    advisors: [],
    advisorWage: {},
    battles: await liveBattles(db, matchId),
    lastStand: { eligible: false, used: false },
    objective: today ? { day: today.day + 1, label: OBJECTIVES[today.key] ?? today.key, yesterday: yday ? { label: OBJECTIVES[yday.key] ?? yday.key, playerId: yday.winnerPlayerId, value: yday.value ?? 0 } : null } : null,
    bounties: bountyRows.map((b) => ({ id: b.id, kind: b.kind as "region" | "player", regionId: b.regionId, playerId: b.playerId, amount: b.amount, reason: b.reason, expiresAt: b.expiresAt?.toISOString() ?? null })),
    notes: [],
    routes: [],
    allies: [],
    observer: true,
    rehireAt: {},
  };
}
