/**
 * Max, the Military advisor. Every pass he draws the front (border regions and what faces them), garrisons and walls
 * the exposed ones, and runs campaigns against the regions marked (or his own picks when aggressive): scouts first,
 * a muster at the nearest region with a land route, then the conquest. Training is supplied by convoys like builds.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { balance, availableBuildings, availableUnits, buildingBlockedBy, buildingById, breachOf, distanceKm, effectsOf, findRoute, regionById, soldierCount, unitById, wallBonusAgainst, wallOf, type AdvisorReport, type AdvisorSettings, type AdvisorSuggestion, type CampaignView, campaignView } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { advisors, armies, jobs, matchRegions, players, playerTechs, regionSightings } from "../db/schema.js";
import type { Publisher } from "../realtime/publish.js";
import { alliesOf } from "./alliances.js";
import { peaceBetween } from "./diplomacy.js";
import { queueBuild, queueTrain, sendArmy, type CommandContext } from "./commands.js";
import { projectRegion, resourceMultOf, type MatchRegionRow } from "./regions.js";
import { parseSettings, type AdvisorRow } from "./advisors.js";
import { notify, type MatchRow } from "../worker/jobs.js";

type PlayerRow = typeof players.$inferSelect;
type Units = Record<string, number>;

/** What is known of a region that is not ours: its units and people, and how good the knowledge is. */
interface Intel {
  regionId: string;
  ownerPlayerId: string | null;
  units: Units;
  population: number;
  buildings: Record<string, number>;
  /** Live from a watchtower, a sighting of this age in game hours, an estimate, or nothing at all. */
  source: "tower" | "sighting" | "estimate" | "none";
  ageHours: number;
  exists: boolean;
}

interface FrontRegion {
  row: MatchRegionRow;
  hostile: Intel[];
  threat: number;
  strength: number;
  exposure: number;
  garrisonTarget: number;
}

const attackOf = (u: Units) => Object.entries(u).reduce((a, [id, n]) => a + n * (unitById.get(id)?.attack ?? 0), 0);
const defenceOf = (u: Units) => Object.entries(u).reduce((a, [id, n]) => a + n * (unitById.get(id)?.defense ?? 0), 0);
const land = (u: Units): Units => Object.fromEntries(Object.entries(u).filter(([id, n]) => n > 0 && !unitById.get(id)?.civilian && !unitById.get(id)?.hauler && !unitById.get(id)?.naval));
const name = (id: string) => regionById(id)?.name ?? id;

/** The best land soldier a player can train here: highest attack plus defence, no siege engines. */
function bestSoldier(age: number, techs: ReadonlySet<string>, regionId: string) {
  const region = regionById(regionId);
  return availableUnits(age, techs)
    .filter((u) => !u.naval && !u.civilian && !u.hauler && !u.hidden && !u.breach && (!u.needsResource || region?.resources.includes(u.needsResource)))
    .sort((a, b) => b.attack + b.defense - (a.attack + a.defense))[0];
}

function bestEngine(age: number, techs: ReadonlySet<string>) {
  return availableUnits(age, techs)
    .filter((u) => !u.naval && !u.hidden && (u.breach ?? 0) > 0)
    .sort((a, b) => (b.breach ?? 0) - (a.breach ?? 0))[0];
}

/**
 * What a player knows about the regions around theirs: a watchtower beside a region sees it live, a scout's report
 * holds for a while, a neutral tribe is guessed at, and the rest is dark.
 */
async function intelFor(db: Db, m: MatchRow, p: PlayerRow, ids: string[], owned: MatchRegionRow[], now: Date): Promise<Map<string, Intel>> {
  const out = new Map<string, Intel>();
  if (!ids.length) return out;
  const rows = await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, ids)));
  const byId = new Map(rows.map((r) => [r.regionId, r]));
  const sightings = await db.select().from(regionSightings).where(and(eq(regionSightings.matchId, m.id), eq(regionSightings.playerId, p.id), inArray(regionSightings.regionId, ids)));
  const seen = new Map(sightings.map((s) => [s.regionId, s]));
  const towers = new Set(owned.filter((r) => effectsOf(r.buildings).watchtower).map((r) => r.regionId));
  const [lo, hi] = [balance.ai.neutralWarriors.min, balance.ai.neutralWarriors.max];
  for (const id of ids) {
    const row = byId.get(id);
    const region = regionById(id);
    const towerSees = !!region && region.neighbors.some((n) => towers.has(n));
    if (row && towerSees) {
      out.set(id, { regionId: id, ownerPlayerId: row.ownerPlayerId, units: row.units, population: Math.round(row.popWorkers + row.popSoldiers + row.popOccupiers), buildings: row.buildings, source: "tower", ageHours: 0, exists: true });
      continue;
    }
    const s = seen.get(id);
    if (s) {
      const snap = s.snapshot as { ownerPlayerId?: string | null; units?: Units; population?: number; buildings?: Record<string, number> };
      out.set(id, { regionId: id, ownerPlayerId: row?.ownerPlayerId ?? snap.ownerPlayerId ?? null, units: snap.units ?? {}, population: snap.population ?? 0, buildings: snap.buildings ?? {}, source: "sighting", ageHours: ((now.getTime() - s.seenAt.getTime()) / 3600_000) * m.speed, exists: !!row });
      continue;
    }
    if (!row) {
      out.set(id, { regionId: id, ownerPlayerId: null, units: {}, population: 0, buildings: {}, source: "none", ageHours: Infinity, exists: false });
      continue;
    }
    // Known to be held, not yet looked at: a neutral tribe's usual band, or a player's unknown garrison, guessed as ten.
    const guess = row.ownerPlayerId ? 10 : Math.round((lo + hi) / 2);
    out.set(id, { regionId: id, ownerPlayerId: row.ownerPlayerId, units: { warrior: guess }, population: Math.round(row.popWorkers), buildings: {}, source: "estimate", ageHours: Infinity, exists: true });
  }
  return out;
}

/** Defenders' strength as an attacker meets it: units' defence plus militia, behind whatever wall stands. */
function defenceStrength(intel: Intel, attackers: Units): number {
  const base = defenceOf(intel.units) + (intel.population / 10) * balance.combat.militiaPerTenPeople * 2;
  return base * (1 + wallBonusAgainst(intel.buildings, attackers));
}

/** The front: every owned region with a hostile neighbour, with what faces it and how exposed it is. */
async function frontOf(db: Db, m: MatchRow, p: PlayerRow, owned: MatchRegionRow[], settings: AdvisorSettings, now: Date): Promise<{ front: FrontRegion[]; intel: Map<string, Intel>; allies: Set<string> }> {
  const ownedIds = new Set(owned.map((r) => r.regionId));
  const allies = new Set(await alliesOf(db, m.id, p.id));
  const around = [...new Set(owned.flatMap((r) => regionById(r.regionId)?.neighbors ?? []))].filter((n) => !ownedIds.has(n));
  const intel = await intelFor(db, m, p, around, owned, now);
  const incoming = await db
    .select({ targetRegionId: armies.targetRegionId, units: armies.units })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.status, "outbound"), inArray(armies.mission, ["raid", "conquer"]), sql`${armies.playerId} <> ${p.id}`, inArray(armies.targetRegionId, [...ownedIds])));
  const front: FrontRegion[] = [];
  for (const row of owned) {
    const hostile = (regionById(row.regionId)?.neighbors ?? [])
      .filter((n) => !ownedIds.has(n))
      .map((n) => intel.get(n)!)
      .filter((i) => i && i.exists && !(i.ownerPlayerId && allies.has(i.ownerPlayerId)));
    if (!hostile.length) continue;
    const marching = incoming.filter((a) => a.targetRegionId === row.regionId).reduce((a, x) => a + attackOf(x.units), 0);
    const threat = Math.max(0, ...hostile.map((i) => attackOf(i.units))) + marching;
    const strength = defenceOf(land(row.units)) * (1 + wallBonusAgainst(row.buildings, {})) + (row.popWorkers / 10) * balance.combat.militiaPerTenPeople * 2;
    const garrisonTarget = settings.garrison * (settings.stance === "passive" ? 2 : 1) * (row.isCapital ? 2 : 1);
    front.push({ row, hostile, threat, strength, exposure: threat / Math.max(1, strength), garrisonTarget });
  }
  front.sort((a, b) => b.exposure - a.exposure);
  return { front, intel, allies };
}

/** One pass of the Military advisor. */
export async function militaryPass(db: Db, m: MatchRow, p: PlayerRow, a: AdvisorRow, now: Date, publisher: Publisher): Promise<AdvisorReport> {
  const c = balance.advisors.military;
  const settings = parseSettings(a.settings);
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
  const techs = new Set(techRows.map((t) => t.id));
  const ctx: CommandContext = { db, m, p, techs };
  const attempt = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (err) {
      return (err as Error).message ?? "refused";
    }
  };
  const skipped: Record<string, number> = {};
  const bump = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1);
  const skip = new Set(settings.skipRegions);
  const suggestions: AdvisorSuggestion[] = [];
  let trained = 0;
  let fortified = 0;
  let moved = 0;
  let queued = 0;

  const owned = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id), isNull(matchRegions.frozenAt), isNull(matchRegions.evacuatedAt)));
  const ownedIds = new Set(owned.map((r) => r.regionId));
  const pending = await db
    .select({ regionId: jobs.regionId, kind: jobs.kind, refId: jobs.refId, qty: jobs.qty, waitingFor: jobs.waitingFor })
    .from(jobs)
    .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, p.id), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
  const queuedAt = (regionId: string) => pending.filter((j) => j.regionId === regionId && (j.kind === "build" || j.kind === "train")).length;
  const trainingAt = (regionId: string, unitId: string) => pending.filter((j) => j.regionId === regionId && j.kind === "train" && j.refId === unitId).reduce((x, j) => x + (j.qty ?? 0), 0);
  const { front, intel, allies } = await frontOf(db, m, p, owned, settings, now);

  // 1. The exposed regions, for the report.
  const exposed = front.slice(0, 5).map((f) => {
    const worst = [...f.hostile].sort((x, y) => attackOf(y.units) - attackOf(x.units))[0];
    const who = worst?.ownerPlayerId ? "a rival" : "a neutral tribe";
    const seen = worst ? (worst.source === "tower" ? "in plain view" : worst.source === "sighting" ? `seen ${Math.round(worst.ageHours)} h ago` : worst.source === "estimate" ? "unscouted, a guess" : "dark") : "";
    const wall = wallOf(f.row.buildings);
    const text = `${name(f.row.regionId)}: ${soldierCount(f.row.units)} soldiers${wall ? ` behind a ${buildingById.get(wall)?.name ?? wall}` : ", no wall"}, facing ${worst ? `${soldierCount(worst.units)} from ${who} in ${name(worst.regionId)} (${seen})` : "nobody"}. Exposure ${f.exposure.toFixed(1)}.`;
    return { regionId: f.row.regionId, exposure: Math.round(f.exposure * 10) / 10, text };
  });

  // 2. Defence: garrisons, reinforcements, walls, worst first.
  let orders = 0;
  for (const f of front) {
    if (skip.has(f.row.regionId)) continue;
    const soldiers = soldierCount(f.row.units);
    const short = f.garrisonTarget - soldiers - trainingAt(f.row.regionId, "*");
    if ((short > 0 || f.exposure > 1) && orders < c.trainPerPass) {
      const best = bestSoldier(p.age, techs, f.row.regionId);
      const already = best ? trainingAt(f.row.regionId, best.id) : 0;
      const want = Math.min(20, Math.max(0, f.garrisonTarget - soldiers - already), Math.floor(f.row.popWorkers) - 1);
      if (best && want >= 1 && queuedAt(f.row.regionId) < balance.queue.slotsPerRegion) {
        const err = await attempt(() => queueTrain(ctx, f.row.regionId, best.id, want, { allowWait: true, maxOwed: c.maxOwed }));
        if (!err) {
          trained += want;
          orders += 1;
        } else bump(/not enough|shipped/.test(err) ? "unaffordable" : /queue is full/.test(err) ? "queueFull" : "blocked");
      }
    }
    if (settings.fortify && fortified < c.fortifyPerPass && (f.exposure >= 0.5 || soldiers < f.garrisonTarget)) {
      const region = regionById(f.row.regionId)!;
      const avail = new Map(availableBuildings(p.age, techs).map((b) => [b.id, b]));
      for (const id of ["palisade", "walls", "watchtower"]) {
        const def = avail.get(id);
        if (!def || (f.row.buildings[id] ?? 0) >= 1 || pending.some((j) => j.regionId === f.row.regionId && j.kind === "build" && j.refId === id)) continue;
        if (buildingBlockedBy(def, region, f.row.buildings, f.row.isCapital)) continue;
        if (queuedAt(f.row.regionId) >= balance.queue.slotsPerRegion) break;
        const err = await attempt(() => queueBuild(ctx, f.row.regionId, id, { allowWait: true, maxOwed: c.maxOwed }));
        if (!err) {
          fortified += 1;
          queued += 1;
        } else bump(/not enough|shipped/.test(err) ? "unaffordable" : "blocked");
        break;
      }
    }
  }
  // Reinforce the exposed from the interior's surplus: the nearest donor with soldiers to spare, one move per donor.
  const needy = front.filter((f) => !skip.has(f.row.regionId) && (f.exposure > 1 || soldierCount(f.row.units) < f.garrisonTarget));
  const frontIds = new Set(front.map((f) => f.row.regionId));
  const donors = owned.filter((r) => !frontIds.has(r.regionId) && !skip.has(r.regionId) && soldierCount(r.units) > settings.garrison).sort((x, y) => soldierCount(y.units) - soldierCount(x.units));
  const used = new Set<string>();
  for (const f of needy) {
    const donor = donors.filter((d) => !used.has(d.regionId) && findRoute(d.regionId, f.row.regionId, false)).sort((x, y) => distanceKm(x.regionId, f.row.regionId) - distanceKm(y.regionId, f.row.regionId))[0];
    if (!donor) continue;
    const spare = soldierCount(donor.units) - settings.garrison;
    const gap = Math.max(0, f.garrisonTarget - soldierCount(f.row.units));
    const n = Math.min(spare, Math.max(gap, Math.ceil(spare / 2)));
    if (n < 1) continue;
    const send: Units = {};
    let left = n;
    for (const [id, q] of Object.entries(land(donor.units))) {
      const take = Math.min(q, left);
      if (take > 0) send[id] = take;
      left -= take;
      if (left <= 0) break;
    }
    const err = await attempt(() => sendArmy(ctx, donor.regionId, { mission: "move", targetRegionId: f.row.regionId, units: send, people: 0, cargo: {} }));
    if (!err) {
      moved += n;
      used.add(donor.regionId);
    }
  }

  // 3. Campaigns.
  let campaigns = campaignView.array().parse(a.campaigns ?? []);
  const active = () => campaigns.filter((x) => x.stage !== "done" && x.stage !== "failed");
  if (settings.stance !== "passive") {
    // Fill open slots from the marked list in order, then, when aggressive, with his own picks.
    const inHand = new Set(campaigns.filter((x) => x.stage !== "failed").map((x) => x.targetRegionId));
    const candidates = settings.targets.filter((t) => !inHand.has(t) && !ownedIds.has(t));
    if (settings.stance === "aggressive") {
      const picks = [...intel.values()]
        .filter((i) => i.exists && !inHand.has(i.regionId) && !settings.targets.includes(i.regionId) && !(i.ownerPlayerId && allies.has(i.ownerPlayerId)))
        .map((i) => ({ i, score: ((regionById(i.regionId)?.value ?? 1) * 100) / (defenceOf(i.units) + 5) / (1 + distanceKm(p.capitalRegionId ?? i.regionId, i.regionId) / 2000) }))
        .sort((x, y) => y.score - x.score)
        .map((x) => x.i.regionId);
      candidates.push(...picks);
    }
    for (const t of candidates) {
      if (active().length >= settings.maxCampaigns) break;
      campaigns.push({ targetRegionId: t, stage: "intel", stagingRegionId: null, need: null, armyId: null, attempts: 0, startedAt: now.toISOString(), note: "" });
    }
  }
  for (const cp of campaigns) {
    if (cp.stage === "done" || cp.stage === "failed") continue;
    const t = cp.targetRegionId;
    if (ownedIds.has(t)) {
      cp.stage = "done";
      cp.note = `${name(t)} is yours.`;
      continue;
    }
    if (settings.stance === "passive") {
      cp.note = "On hold: the stance is passive.";
      continue;
    }
    // Who holds it, and whether we may attack them at all.
    const [trow] = await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, t))).limit(1);
    const owner = trow?.ownerPlayerId ?? null;
    if (owner) {
      if (allies.has(owner)) {
        cp.stage = "failed";
        cp.note = `${name(t)} belongs to an ally.`;
        continue;
      }
      const [o] = await db.select({ protectionUntil: players.protectionUntil, name: players.name }).from(players).where(eq(players.id, owner)).limit(1);
      if (o?.protectionUntil && o.protectionUntil > now) {
        cp.note = `${o.name} is under beginner protection until day ${Math.ceil(((o.protectionUntil.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed)}; waiting.`;
        bump("protected");
        continue;
      }
      if (await peaceBetween(db, m.id, p.id, owner, now)) {
        cp.note = `A pact or ceasefire with ${o?.name ?? "them"} forbids it; waiting.`;
        bump("pact");
        continue;
      }
    }
    const empty = !trow || (!owner && trow.popWorkers + trow.popSoldiers + trow.popOccupiers < 1 && Object.values(trow.units).every((n) => n <= 0));
    // Intel.
    let known = intel.get(t);
    if (!known) {
      const one = await intelFor(db, m, p, [t], owned, now);
      known = one.get(t);
      if (known) intel.set(t, known);
    }
    const fresh = empty || !settings.scoutFirst || (known && (known.source === "tower" || (known.source === "sighting" && known.ageHours <= c.sightingMaxHours)));
    if (cp.stage === "intel") {
      if (fresh) cp.stage = "muster";
      else {
        const scoutsOut = await db.select({ id: armies.id }).from(armies).where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "scout"), eq(armies.status, "outbound"), eq(armies.targetRegionId, t))).limit(1);
        if (scoutsOut.length) {
          cp.note = `Scouts are on their way to ${name(t)}.`;
          continue;
        }
        const scout = balance.scoutUnit;
        const from = owned.filter((r) => !skip.has(r.regionId) && (r.units[scout] ?? 0) >= 1 && findRoute(r.regionId, t, false)).sort((x, y) => distanceKm(x.regionId, t) - distanceKm(y.regionId, t))[0];
        if (from) {
          const n = Math.min(2, from.units[scout] ?? 0);
          const err = await attempt(() => sendArmy(ctx, from.regionId, { mission: "scout", targetRegionId: t, units: { [scout]: n }, people: 0, cargo: {} }));
          cp.note = err ? `Could not send scouts to ${name(t)}: ${err}.` : `${n} scout${n === 1 ? "" : "s"} sent to ${name(t)} from ${name(from.regionId)}.`;
        } else {
          const near = owned.filter((r) => !skip.has(r.regionId) && findRoute(r.regionId, t, false)).sort((x, y) => distanceKm(x.regionId, t) - distanceKm(y.regionId, t))[0];
          if (near && trainingAt(near.regionId, scout) === 0) {
            const err = await attempt(() => queueTrain(ctx, near.regionId, scout, 2, { allowWait: true, maxOwed: c.maxOwed }));
            cp.note = err ? `No scouts, and none could be trained at ${name(near.regionId)}: ${err}.` : `Training 2 scouts at ${name(near.regionId)} for ${name(t)}.`;
          } else cp.note = near ? `Scouts are training at ${name(near.regionId)}.` : `No region of yours can reach ${name(t)} by land.`;
        }
        continue;
      }
    }
    // Muster.
    if (cp.stage === "muster") {
      const staging = owned.filter((r) => !skip.has(r.regionId) && findRoute(r.regionId, t, false)).sort((x, y) => distanceKm(x.regionId, t) - distanceKm(y.regionId, t))[0];
      if (!staging) {
        cp.stage = "failed";
        cp.note = `No region of yours can reach ${name(t)} by land.`;
        bump("noRoute");
        continue;
      }
      cp.stagingRegionId = staging.regionId;
      const best = bestSoldier(p.age, techs, staging.regionId);
      if (!best) {
        cp.note = "No soldier can be trained yet.";
        continue;
      }
      const settlers = empty ? balance.settle.settlersRequired : balance.conquest.occupiersRequired;
      let qty = 0;
      let siege: { unit: string; qty: number } | null = null;
      if (!empty && known) {
        const margin = c.forceMargin * Math.pow(c.retryMargin, cp.attempts);
        const probe: Units = { [best.id]: 1 };
        const wall = wallOf(known.buildings);
        if (wall) {
          const engine = bestEngine(p.age, techs);
          const need = balance.combat.wallBreach[wall] ?? 0;
          if (engine && need > 0) {
            siege = { unit: engine.id, qty: Math.min(20, Math.ceil(need / (engine.breach ?? 1))) };
            probe[engine.id] = siege.qty;
          }
        }
        qty = Math.max(3, Math.ceil((defenceStrength(known, probe) * margin) / Math.max(1, best.attack)));
      }
      cp.need = { unit: best.id, qty, settlers, siege };
      const have = staging.units[best.id] ?? 0;
      const haveSettlers = staging.units.settler ?? 0;
      const haveSiege = siege ? (staging.units[siege.unit] ?? 0) : 0;
      const ready = have >= qty && haveSettlers >= settlers && (!siege || haveSiege >= siege.qty);
      if (ready) {
        const send: Units = { settler: settlers };
        if (qty > 0) send[best.id] = qty;
        if (siege) send[siege.unit] = siege.qty;
        const err = await attempt(async () => {
          const r = await sendArmy(ctx, staging.regionId, { mission: empty ? "settle" : "conquer", targetRegionId: t, units: send, people: 0, cargo: {} });
          cp.armyId = r.army.id;
        });
        if (err) {
          cp.note = `Could not march on ${name(t)}: ${err}.`;
          bump("blocked");
        } else {
          cp.stage = "marching";
          cp.note = `${empty ? "Settlers" : `${qty} ${best.name}${qty === 1 ? "" : "s"} and ${settlers} settlers`} marching from ${name(staging.regionId)} on ${name(t)}.`;
        }
        continue;
      }
      // Train what is missing, within the pass's training budget.
      const parts: string[] = [];
      const freeWorkers = Math.floor(staging.popWorkers) - pending.filter((j) => j.regionId === staging.regionId && j.kind === "train").reduce((x, j) => x + (j.qty ?? 0), 0);
      let workersShort = false;
      const order = async (unitId: string, wanted: number, unitName: string) => {
        if (wanted < 1 || orders >= c.trainPerPass) return;
        if (queuedAt(staging.regionId) >= balance.queue.slotsPerRegion) {
          bump("queueFull");
          return;
        }
        const def = unitById.get(unitId);
        const n = Math.max(def?.minBatch ?? 1, Math.min(20, wanted));
        if (freeWorkers < n) {
          workersShort = true;
          return;
        }
        const err = await attempt(() => queueTrain(ctx, staging.regionId, unitId, n, { allowWait: true, maxOwed: c.maxOwed }));
        if (!err) {
          trained += n;
          orders += 1;
          parts.push(`${n} ${unitName}`);
        } else bump(/not enough|shipped/.test(err) ? "unaffordable" : /queue is full/.test(err) ? "queueFull" : "blocked");
      };
      await order(best.id, qty - have - trainingAt(staging.regionId, best.id), best.name.toLowerCase());
      await order("settler", settlers - haveSettlers - trainingAt(staging.regionId, "settler"), "settlers");
      if (siege) await order(siege.unit, siege.qty - haveSiege - trainingAt(staging.regionId, siege.unit), unitById.get(siege.unit)?.name.toLowerCase() ?? siege.unit);
      if (workersShort) {
        // Mara brings people when she is hired and allowed to move them; otherwise the player is told.
        const [mara] = await db.select({ settings: advisors.settings, unpaidSince: advisors.unpaidSince }).from(advisors).where(and(eq(advisors.matchId, m.id), eq(advisors.playerId, p.id), eq(advisors.kind, "economic"), isNull(advisors.firedAt))).limit(1);
        const maraMoves = mara && !mara.unpaidSince && parseSettings(mara.settings).population !== "off";
        if (maraMoves) {
          const crowded = owned
            .filter((r) => r.regionId !== staging.regionId && !skip.has(r.regionId) && r.popWorkers > 30 && findRoute(r.regionId, staging.regionId, false))
            .sort((x, y) => y.popWorkers / Math.max(1, projectRegion(y, now, m.speed, undefined, resourceMultOf(m)).economy.capacity) - x.popWorkers / Math.max(1, projectRegion(x, now, m.speed, undefined, resourceMultOf(m)).economy.capacity))[0];
          if (crowded) {
            const n = Math.min(Math.floor(crowded.popWorkers * 0.2), 40);
            const err = await attempt(() => sendArmy(ctx, crowded.regionId, { mission: "move", targetRegionId: staging.regionId, units: {}, people: n, cargo: {} }));
            if (!err) {
              moved += n;
              parts.push(`${n} people coming from ${name(crowded.regionId)}`);
            }
          }
        } else suggestions.push({ regionId: staging.regionId, text: `${name(staging.regionId)} has too few free workers to raise the force for ${name(t)}: move people there, or hire the Economic advisor to bring them.` });
      }
      cp.note = `Mustering at ${name(staging.regionId)} for ${name(t)}: ${have} of ${qty} ${best.name.toLowerCase()}${qty === 1 ? "" : "s"}, ${haveSettlers} of ${settlers} settlers${siege ? `, ${haveSiege} of ${siege.qty} ${unitById.get(siege.unit)?.name.toLowerCase() ?? siege.unit}s` : ""}${parts.length ? `; ordered ${parts.join(", ")}` : ""}.`;
      continue;
    }
    // Marching: wait for the army; judge the outcome by who holds the region once it is over.
    if (cp.stage === "marching") {
      const [army] = cp.armyId ? await db.select().from(armies).where(eq(armies.id, cp.armyId)).limit(1) : [];
      if (army && army.status === "outbound") {
        cp.note = `${name(t)}: the force arrives in ${Math.max(1, Math.round(((army.arrivesAt.getTime() - now.getTime()) / 3600_000) * m.speed))} h.`;
        continue;
      }
      const [after] = await db.select({ owner: matchRegions.ownerPlayerId }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, t))).limit(1);
      if (after?.owner === p.id) {
        cp.stage = "done";
        cp.note = `${name(t)} is yours.`;
        continue;
      }
      if (army && army.status === "returning") {
        cp.note = `The force is coming home from ${name(t)}.`;
        continue;
      }
      cp.attempts += 1;
      if (cp.attempts >= c.maxAttempts) {
        cp.stage = "failed";
        cp.note = `${name(t)} held against ${cp.attempts} attempts; the campaign is abandoned.`;
        await notify(db as unknown as Parameters<typeof notify>[0], m.id, p.id, "battle", `Your Military advisor has given up on ${name(t)} after ${cp.attempts} attempts`, { regionId: t, advisor: "military" });
      } else {
        cp.stage = "muster";
        cp.armyId = null;
        cp.note = `Beaten at ${name(t)}; mustering again, ${Math.round((c.retryMargin - 1) * 100)}% larger.`;
      }
    }
  }
  // Keep the list short: finished campaigns fall off after the latest six.
  const finished = campaigns.filter((x) => x.stage === "done" || x.stage === "failed");
  campaigns = [...campaigns.filter((x) => x.stage !== "done" && x.stage !== "failed"), ...finished.slice(-6)];

  // 4. Raids: aggressive only, one a pass, from a border region with soldiers to spare against the weakest rich neighbour.
  if (settings.stance === "aggressive" && settings.raids) {
    for (const f of front) {
      if (skip.has(f.row.regionId)) continue;
      const spare = soldierCount(f.row.units) - f.garrisonTarget;
      if (spare < 6) continue;
      const prey = f.hostile
        .filter((i) => i.exists && i.source !== "none" && !(i.ownerPlayerId && allies.has(i.ownerPlayerId)))
        .sort((x, y) => defenceStrength(x, {}) - defenceStrength(y, {}))[0];
      if (!prey) continue;
      if (prey.ownerPlayerId) {
        const [o] = await db.select({ protectionUntil: players.protectionUntil }).from(players).where(eq(players.id, prey.ownerPlayerId)).limit(1);
        if (o?.protectionUntil && o.protectionUntil > now) continue;
        if (await peaceBetween(db, m.id, p.id, prey.ownerPlayerId, now)) continue;
      }
      const force: Units = {};
      let left = spare;
      for (const [id, q] of Object.entries(land(f.row.units))) {
        const take = Math.min(q, left);
        if (take > 0) force[id] = take;
        left -= take;
        if (left <= 0) break;
      }
      if (attackOf(force) < defenceStrength(prey, force) * 2) continue;
      const err = await attempt(() => sendArmy(ctx, f.row.regionId, { mission: "raid", targetRegionId: prey.regionId, units: force, people: 0, cargo: {} }));
      if (!err) {
        suggestions.push({ regionId: prey.regionId, text: `Raiding ${name(prey.regionId)} from ${name(f.row.regionId)} with ${spare} soldiers to spare.` });
        break;
      }
    }
  }

  for (const cp of campaigns.filter((x) => x.stage !== "done" && x.stage !== "failed")) suggestions.unshift({ regionId: cp.targetRegionId, text: cp.note || `${name(cp.targetRegionId)}: ${cp.stage}.` });
  for (const e of exposed.filter((x) => x.exposure >= 1)) suggestions.push({ regionId: e.regionId, text: e.text });
  const report: AdvisorReport = { at: now.toISOString(), queued, moved, rebalanced: 0, trained, fortified, skipped, suggestions: suggestions.slice(0, 14), exposed };
  await db.update(advisors).set({ lastPassAt: now, lastReport: report, campaigns }).where(eq(advisors.id, a.id));
  await publisher.toPlayer(m.id, p.id, "advisor.report", { kind: a.kind, trained, fortified, campaigns: campaigns.length });
  return report;
}
