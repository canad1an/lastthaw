import { and, eq, inArray, isNull } from "drizzle-orm";
import { allRegions, balance, iceExposure, iceLatitudeOnDay, regionById } from "@lastthaw/shared";
import { events, jobs, matchRegions, players } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { settleAndLockRegion, type Tx } from "./regions.js";
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
  const toFreeze = allRegions().filter((r) => Math.abs(r.lat) >= lat).map((r) => r.id);
  const rows = toFreeze.length
    ? await tx
        .select({ regionId: matchRegions.regionId, owner: matchRegions.ownerPlayerId })
        .from(matchRegions)
        .where(and(eq(matchRegions.matchId, m.id), isNull(matchRegions.frozenAt), inArray(matchRegions.regionId, toFreeze)))
    : [];
  if (taperChanges.length === 0 && rows.length === 0) return;
  // Lock every region we touch in ascending order (the lock order used everywhere) before changing any.
  const touched = [...new Set([...taperChanges.map((t) => t.regionId), ...rows.map((r) => r.regionId)])].sort();
  for (const id of touched) await settleAndLockRegion(tx, m.id, id, job.endsAt, m.speed);
  for (const t of taperChanges) {
    await tx.update(matchRegions).set({ iceFactor: t.factor }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, t.regionId)));
  }
  const byOwner = new Map<string, string[]>();
  for (const r of rows) {
    await tx.update(matchRegions).set({ frozenAt: job.endsAt, iceFactor: 0 }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, r.regionId)));
    if (r.owner) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r.regionId]);
  }
  await tx.insert(events).values({ matchId: m.id, at: job.endsAt, kind: "ice.advanced", payload: { day, latitude: lat, frozen: rows.length } });
  for (const [owner, regions] of byOwner) {
    const names = regions.map((id) => regionById(id)?.name ?? id).join(", ");
    await notify(tx, m.id, owner, "system", `The ice has reached ${names}. Production there has stopped and people will leave or die.`, { regions, day });
  }
  const humans = await tx.select({ id: players.id }).from(players).where(and(eq(players.matchId, m.id), eq(players.isAi, false)));
  if (day % 5 === 0) {
    for (const p of humans) {
      if (byOwner.has(p.id)) continue;
      await notify(tx, m.id, p.id, "system", `Day ${day}: the ice now covers everything beyond ${lat.toFixed(0)}° latitude.`, { day, latitude: lat });
    }
  }
  after(() => publisher.toMatch(m.id, "region.updated", { ice: { day, latitude: lat } }));
}
