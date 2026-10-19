import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { allRegions, balance, emptySpecial, iceExposure, iceLatitudeOnDay, regionById, seededRng, freezeDayForLatitude } from "@lastthaw/shared";
import { events, jobs, matchRegions, matches, players, refugeeOffers } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { settleAndLockRegion, type Tx, resourceMultOf } from "./regions.js";
import { notify, type JobRow, type MatchRow } from "../worker/jobs.js";

/** Create one ice_step job per match day at match start. */
export async function scheduleIce(tx: Tx, matchId: string, startsAt: Date, speed: number): Promise<void> {
  const dayMs = (86400 * 1000) / speed;
  for (let day = 1; day <= balance.match.lengthDays; day++) {
    const at = new Date(startsAt.getTime() + day * dayMs);
    await tx.insert(jobs).values({ matchId, kind: "ice_step", payload: { day }, startsAt, endsAt: at });
  }
}

/**
 * Freeze every region beyond the day's ice line. Settles each affected region
 * first so production up to the freeze is credited, then flips `frozenAt`.
 */
export async function applyIceStep(tx: Tx, m: MatchRow, job: JobRow, publisher: Publisher, after: (fn: () => Promise<void>) => void): Promise<void> {
  const day = (job.payload as { day?: number }).day ?? 1;
  const lat = iceLatitudeOnDay(day);
  // Taper: regions the line has entered but not yet passed at the centre produce less.
  const tapering = allRegions()
    .map((r) => ({ id: r.id, ...iceExposure(r, day) }))
    .filter((x) => x.touched && !x.frozen);
  const taperRows = tapering.length
    ? await tx
        .select({ regionId: matchRegions.regionId, iceFactor: matchRegions.iceFactor })
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, m.id), isNull(matchRegions.frozenAt), inArray(matchRegions.regionId, tapering.map((t) => t.id))))
    : [];
  const taperChanges = taperRows
    .map((row) => ({ regionId: row.regionId, factor: tapering.find((t) => t.id === row.regionId)!.factor, current: row.iceFactor }))
    .filter((x) => Math.abs(x.factor - x.current) >= 0.01);
  // A thaw pocket: once or twice a match a valuable region that should freeze soon stays open a few days longer.
  const thaw = balance.events.thaw;
  const settings = (m.settings ?? {}) as { thawPockets?: number };
  if (day >= thaw.fromDay && day <= thaw.toDay && (settings.thawPockets ?? 0) < thaw.max) {
    const rng = seededRng(`${m.seed}:thaw:${day}`);
    if (rng() < thaw.chance) {
      const soonLat = iceLatitudeOnDay(day + 2);
      const soon = allRegions().filter((r) => Math.abs(r.lat) < lat && Math.abs(r.lat) >= soonLat && r.terrain !== "tundra").sort((a, b) => b.value - a.value).slice(0, 8);
      const pick = soon[Math.floor(rng() * soon.length)];
      if (pick) {
        const freezeDay = freezeDayForLatitude(Math.abs(pick.lat)) ?? day + 2;
        const until = new Date(m.startsAt.getTime() + ((freezeDay + thaw.extraDays) * 86400_000) / m.speed);
        await tx.update(matchRegions).set({ thawUntil: until }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, pick.id)));
        await tx.update(matches).set({ settings: { ...(m.settings as object), thawPockets: (settings.thawPockets ?? 0) + 1 } }).where(eq(matches.id, m.id));
        await tx.insert(events).values({ matchId: m.id, at: job.endsAt, kind: "thaw.pocket", payload: { regionId: pick.id, until: until.toISOString(), day } });
        const everyone = await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, m.id), eq(players.isAi, false)));
        for (const p of everyone) await notify(tx, m.id, p.id, "system", `A warm pocket lingers over ${pick.name}: the ice passes it by until day ${Math.round(freezeDay + thaw.extraDays)}. A last chance for whoever holds it.`, { regionId: pick.id, until: until.toISOString(), thaw: true });
      }
    }
  }
  const toFreeze = allRegions().filter((r) => Math.abs(r.lat) >= lat).map((r) => r.id);
  const rows = toFreeze.length
    ? await tx
        .select({ regionId: matchRegions.regionId, owner: matchRegions.ownerPlayerId, thawUntil: matchRegions.thawUntil })
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, m.id), isNull(matchRegions.frozenAt), inArray(matchRegions.regionId, toFreeze)))
    : [];
  const spared = rows.filter((r) => r.thawUntil && r.thawUntil > job.endsAt).map((r) => r.regionId);
  const freezing = rows.filter((r) => !spared.includes(r.regionId));
  if (taperChanges.length === 0 && freezing.length === 0) return;
  // Lock every region we touch in ascending order (the lock order used everywhere) before changing any.
  const touched = [...new Set([...taperChanges.map((t) => t.regionId), ...freezing.map((r) => r.regionId)])].sort();
  const settled = new Map<string, Awaited<ReturnType<typeof settleAndLockRegion>>>();
  for (const id of touched) settled.set(id, await settleAndLockRegion(tx, m.id, id, job.endsAt, m.speed, resourceMultOf(m)));
  for (const t of taperChanges) {
    await tx.update(matchRegions).set({ iceFactor: t.factor }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, t.regionId)));
  }
  const byOwner = new Map<string, string[]>();
  const columns: Array<{ from: string; people: number }> = [];
  for (const r of freezing) {
    // Some of the people get out ahead of the ice as a migrant column (see below).
    const before = settled.get(r.regionId);
    const people = before ? Math.floor((before.popWorkers + before.popOccupiers) * balance.events.refugees.share) : 0;
    if (people >= 5) columns.push({ from: r.regionId, people });
    // Fully frozen: nothing and nobody survives. Stores, people and units all go to zero.
    await tx
      .update(matchRegions)
      .set({ frozenAt: job.endsAt, iceFactor: 0, food: 0, wood: 0, stone: 0, special: emptySpecial(), popWorkers: 0, popSoldiers: 0, popOccupiers: 0, units: {} })
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
    if (r.owner) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r.regionId]);
  }
  // A step that only tapers factors is not news; the feed hears about the ice when it takes land.
  if (freezing.length > 0) await tx.insert(events).values({ matchId: m.id, at: job.endsAt, kind: "ice.advanced", payload: { day, latitude: lat, frozen: freezing.length, regions: freezing.map((r) => r.regionId).slice(0, 12), spared } });
  await offerRefugees(tx, m, job.endsAt, columns);
  for (const [owner, regions] of byOwner) {
    const names = regions.map((id) => regionById(id)?.name ?? id).join(", ");
    await notify(tx, m.id, owner, "system", `The ice has taken ${names}. Everything and everyone there is lost.`, { regions, day });
  }
  await settleFrozenCapitals(tx, m, job.endsAt, byOwner);
  const humans = await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, m.id), eq(players.isAi, false)));
  if (day % 5 === 0) {
    for (const p of humans) {
      if (byOwner.has(p.id)) continue;
      await notify(tx, m.id, p.id, "system", `Day ${day}: the ice now covers everything beyond ${lat.toFixed(0)}° latitude.`, { day, latitude: lat });
    }
  }
  after(() => publisher.toMatch(m.id, "region.updated", { ice: { day, latitude: lat } }));
}

/**
 * Migrant columns: the people who got out of each freezing region walk to the
 * nearest unfrozen empire within a couple of hops and wait at its border. The
 * owner has a day to take them in (for food) or turn them away.
 */
async function offerRefugees(tx: Tx, m: MatchRow, at: Date, columns: Array<{ from: string; people: number }>): Promise<void> {
  if (columns.length === 0) return;
  const c = balance.events.refugees;
  const owned = await tx
    .select({ regionId: matchRegions.regionId, owner: matchRegions.ownerPlayerId })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), isNotNull(matchRegions.ownerPlayerId), isNull(matchRegions.frozenAt), isNull(matchRegions.evacuatedAt)));
  const ownerOf = new Map(owned.map((r) => [r.regionId, r.owner!]));
  const expiresAt = new Date(at.getTime() + (c.hours * 3600_000) / m.speed);
  for (const col of columns) {
    // Breadth-first out to `hops`, nearest owned region first.
    let ring = [col.from];
    const seen = new Set(ring);
    let dest: string | null = null;
    for (let h = 0; h < c.hops && !dest; h++) {
      const next: string[] = [];
      for (const id of ring) for (const n of regionById(id)?.neighbors ?? []) if (!seen.has(n)) { seen.add(n); next.push(n); }
      const here = next.filter((n) => ownerOf.has(n));
      if (here.length) dest = here[0]!;
      ring = next;
    }
    const fromName = regionById(col.from)?.name ?? col.from;
    if (!dest) {
      await tx.insert(events).values({ matchId: m.id, at, kind: "refugees.lost", payload: { fromRegionId: col.from, people: col.people } });
      continue;
    }
    const owner = ownerOf.get(dest)!;
    await tx.insert(refugeeOffers).values({ matchId: m.id, playerId: owner, regionId: dest, fromRegionId: col.from, people: col.people, expiresAt });
    await notify(tx, m.id, owner, "battle", `${col.people} people fleeing the ice from ${fromName} have reached ${regionById(dest)?.name ?? dest}. Take them in for ${col.people * c.foodPerPerson} food, or turn them away; they wait a day.`, { regionId: dest, fromRegionId: col.from, people: col.people, expiresAt: expiresAt.toISOString(), refugees: true });
    await tx.insert(events).values({ matchId: m.id, at, kind: "refugees.arrived", payload: { fromRegionId: col.from, regionId: dest, playerId: owner, people: col.people } });
  }
}

/**
 * Owners whose capital just froze: the capital moves to their most populous
 * unfrozen region at once (the wagon would not survive the trip anyway), and a
 * player with no unfrozen land left is out of the match instead of lingering
 * on the ice with nothing.
 */
export async function settleFrozenCapitals(tx: Tx, m: MatchRow, at: Date, frozenByOwner: Map<string, string[]>): Promise<void> {
  if (frozenByOwner.size === 0) return;
  const owners = await tx
    .select()
    .from(players)
    .where(and(eq(players.matchId, m.id), inArray(players.id, [...frozenByOwner.keys()]), isNull(players.eliminatedAt)));
  for (const p of owners) {
    if (!p.capitalRegionId || !frozenByOwner.get(p.id)?.includes(p.capitalRegionId)) continue;
    const left = await tx
      .select()
      .from(matchRegions)
      .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt)))
      .orderBy(desc(matchRegions.popWorkers), desc(matchRegions.popSoldiers));
    const next = left[0];
    if (!next) {
      const { eliminatePlayer } = await import("./missions.js");
      await eliminatePlayer(tx, m, p.id, at, "The ice has taken your last region.");
      continue;
    }
    await tx.update(matchRegions).set({ isCapital: false }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, p.capitalRegionId)));
    await tx.update(matchRegions).set({ isCapital: true }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, next.regionId)));
    await tx.update(players).set({ capitalRegionId: next.regionId }).where(eq(players.id, p.id));
    await notify(tx, m.id, p.id, "system", `The ice has taken your capital. ${regionById(next.regionId)?.name ?? next.regionId} is the capital now.`, { regionId: next.regionId, capital: true });
    await tx.insert(events).values({ matchId: m.id, at, kind: "capital.moved", payload: { playerId: p.id, regionId: next.regionId, from: p.capitalRegionId, ice: true } });
  }
}
