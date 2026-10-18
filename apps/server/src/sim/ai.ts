import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { availableBuildings, availableTechs, buildingBlockedBy, availableUnits, balance, buildingById, buildingCost, dayCostMultiplier, effectsOf, freezeDayForLatitude, distanceKm, regionById, seededRng, techById, techCost, normalizeAssignment, type Cost, techEffectsOf, haulerCount, unitById, TECHS, breachOf, wallBonusAgainst } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { armies, bounties, jobs, marketOrders, matchRegions, mercenaryOffers, playerTechs, players, refugeeOffers, pacts } from "../db/schema.js";
import { hireMercenaries } from "./worldEvents.js";
import { lastStand } from "./lastStand.js";
import type { Publisher } from "../realtime/publish.js";
import { applyCost, projectRegion, settleAndLockRegion, stockOf, type MatchRegionRow } from "./regions.js";
import { queueBuild, queueResearch, queueTrain, sendArmy, type CommandContext, type PlayerRow } from "./commands.js";
import { areAllied } from "./alliances.js";
import { acceptMarketOrder } from "../matches/marketApi.js";
import { decideRefugees } from "../matches/eventsApi.js";
import { payTribute, proposePact, respondPact } from "./diplomacy.js";
import type { MatchRow } from "../worker/jobs.js";

export type Difficulty = "easy" | "medium" | "hard";
export type Temperament = "peaceful" | "balanced" | "raider";

const BUILD_ORDER = ["huts", "hunting_grounds", "lumber_camp", "storehouse", "quarry", "farm", "palisade", "granary", "mine", "stables", "walls", "barracks", "roads", "railway", "temple", "forge", "market", "aqueduct", "fort", "library", "harbor", "windmill", "castle", "guild_hall", "university", "cathedral", "factory", "arsenal", "power_plant", "bunker", "great_hearth"];
const RESEARCH_ORDER = [
  "fire_making", "flint_tools", "agriculture", "fishing_nets", "stone_axes", "animal_husbandry", "weaving", "bronze_working",
  "mining", "irrigation", "writing", "the_wheel", "wagon_building", "pottery", "herbal_medicine", "road_building", "bronze_weapons", "iron_working",
  "masonry", "crop_rotation", "iron_tools", "mathematics", "iron_weapons", "siegecraft", "drill",
  "engineering", "heavy_plough", "philosophy", "logistics", "civil_service", "steel", "shipbuilding", "chivalry",
  "three_field_system", "railways", "guilds", "blast_furnace", "plate_armour", "siege_engines", "scholasticism", "industrialisation",
  "steam_power", "telegraph", "rifling", "vaccination", "electronics",
  "oral_tradition", "trapping", "basketry", "salt_curing", "shelter_building", "tribal_councils", "copper_smelting", "harness", "calendar", "brick_making", "shield_wall", "sailing", "surveying", "quarrying", "carpentry", "fortification", "coinage", "scouting", "cartography", "navigation", "architecture", "concrete", "literature", "metallurgy", "professional_army", "provincial_administration", "currency", "water_mills", "iron_casting", "crossbows", "gunpowder", "trade_fairs", "banking", "compass", "printing_press", "coal_mining", "steel_mills", "textile_mills", "canning", "public_schools", "railway_signalling", "mass_production", "dynamite", "sanitation", "internal_combustion", "radio", "mass_media", "computers", "assembly_line", "refrigeration", "antibiotics", "aviation", "mechanised_agriculture", "nuclear_power",
  "electricity", "combined_arms", "radar", "synthetic_fertilizer", "ballistics", "satellites",
];

/** What a tribe demands in tribute: a share of the victim's capital stock, which a reasonable tribe can pay. */
export function tributeDemand(stock: Record<string, number>, resource: string): number {
  const c = balance.ai;
  return Math.max(c.tributeMin, Math.min(c.tributeMax, Math.floor((stock[resource] ?? 0) * c.tributeShare)));
}

/** What each difficulty is allowed to do. Harder tiers never cheat; they just decide better and more often. */
const TIER = {
  easy: { cadence: { min: 60, max: 120 }, buildCap: (age: number) => 8 + age * 3, aggression: 0.7, reactsToThreat: false, iceRetreatDays: 1, adaptiveEconomy: false, adaptiveResearch: false, conquersHumans: false, scoresTargets: false, hoards: true, reach: 1, settles: true },
  medium: { cadence: { min: 40, max: 90 }, buildCap: (age: number) => 10 + age * 3, aggression: 1, reactsToThreat: true, iceRetreatDays: 2, adaptiveEconomy: false, adaptiveResearch: false, conquersHumans: true, scoresTargets: false, hoards: false, reach: 2, settles: true },
  hard: { cadence: { min: 20, max: 45 }, buildCap: (age: number) => 14 + age * 4, aggression: 1.4, reactsToThreat: true, iceRetreatDays: 4, adaptiveEconomy: true, adaptiveResearch: true, conquersHumans: true, scoresTargets: true, hoards: false, reach: 3, settles: true },
} as const;

export function parseProfile(profile: string | null): { difficulty: Difficulty; temperament: Temperament } {
  const [a, b] = (profile ?? "medium:balanced").split(":");
  const difficulty = (["easy", "medium", "hard"].includes(a ?? "") ? a : "medium") as Difficulty;
  const temperament = (["peaceful", "balanced", "raider"].includes(b ?? "") ? b : "balanced") as Temperament;
  return { difficulty, temperament };
}

/** Pick a profile for a new AI tribe from the match's difficulty setting. */
export function randomProfile(rng: () => number, setting: string | undefined): string {
  const mix = balance.ai.difficultyMix;
  let difficulty: Difficulty;
  if (setting === "easy" || setting === "medium" || setting === "hard") difficulty = setting;
  else {
    const r = rng();
    difficulty = r < mix.easy ? "easy" : r < mix.easy + mix.medium ? "medium" : "hard";
  }
  const t = rng();
  const temperament: Temperament = t < 0.3 ? "peaceful" : t < 0.75 ? "balanced" : "raider";
  return `${difficulty}:${temperament}`;
}

/**
 * One round of decisions for an AI tribe. Uses the same commands as humans.
 * Each action is independent: a failure (cannot afford, queue full) is ignored.
 */
export async function runAiPlayer(db: Db, m: MatchRow, p: PlayerRow, now: Date, _publisher: Publisher): Promise<void> {
  const { difficulty, temperament } = parseProfile(p.aiProfile);
  const tier = TIER[difficulty];
  // Every tribe has its own streak, fixed for the match, so two mediums never play the same way:
  // how often it strikes, how much risk it accepts, and whether it holds a grudge against the leader.
  const persona = personaOf(m.seed, p.id, difficulty);
  const rng = seededRng(`${m.seed}:${p.id}:${now.getTime()}`);
  const techRows = await db.select({ id: playerTechs.techId }).from(playerTechs).where(eq(playerTechs.playerId, p.id));
  const techs = new Set(techRows.map((t) => t.id));
  const techFx = techEffectsOf(techs);
  const ctx: CommandContext = { db, m, p, techs };
  const attempt = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };

  const owned = await db
    .select()
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.ownerPlayerId, p.id)));
  if (owned.length === 0) return;
  const pendingJobs = await db
    .select({ regionId: jobs.regionId, kind: jobs.kind, refId: jobs.refId, waitingFor: jobs.waitingFor })
    .from(jobs)
    .where(and(eq(jobs.matchId, m.id), eq(jobs.playerId, p.id), isNull(jobs.completedAt), isNull(jobs.cancelledAt)));
  // Migrant columns at the border: take them in when the food is there and the region has room to spare.
  const waiting = await db.select().from(refugeeOffers).where(and(eq(refugeeOffers.playerId, p.id), isNull(refugeeOffers.decidedAt)));
  for (const offer of waiting) {
    const region = owned.find((r) => r.regionId === offer.regionId);
    if (!region) continue;
    const { economy } = projectRegion(region, now, m.speed, techFx);
    const crowded = economy.popWorkers + economy.popSoldiers + economy.popOccupiers + offer.people > economy.capacity * 1.5;
    const ok = !crowded && economy.food >= offer.people * balance.events.refugees.foodPerPerson * 1.5;
    await attempt(() => decideRefugees(db, m, p, offer.id, ok));
  }
  // Diplomacy: answer what is on the table; the hungry demand tribute of a weaker neighbour now and then.
  const proposals = await db.select().from(pacts).where(and(eq(pacts.matchId, m.id), eq(pacts.bPlayerId, p.id), eq(pacts.status, "proposed")));
  for (const pr of proposals) {
    if (pr.kind === "tribute") {
      const terms = pr.terms as { resource: string; amount: number };
      const capital = owned.find((r) => r.regionId === p.capitalRegionId);
      const have = capital ? (stockOf(capital)[terms.resource] ?? 0) : 0;
      if (have > 0 && terms.amount <= have * 0.1 && persona.aggression < 1.3) await attempt(() => payTribute(db, m, p, pr.id));
      continue;
    }
    await attempt(() => respondPact(db, m, p, pr.id, persona.aggression <= 1.2 || difficulty === "easy"));
  }
  if (difficulty === "hard" && persona.aggression > 1 && rng() < 0.03) {
    const weaker = (await db.select().from(players).where(and(eq(players.matchId, m.id), eq(players.hidden, false), isNull(players.eliminatedAt)))).filter((o) => o.id !== p.id && o.score < p.score * 0.7 && o.capitalRegionId);
    const victim = weaker[Math.floor(rng() * weaker.length)];
    if (victim) {
      const [vc] = victim.capitalRegionId ? await db.select().from(matchRegions).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, victim.capitalRegionId))).limit(1) : [];
      await attempt(() => proposePact(db, m, p, victim.id, "tribute", { resource: "wood", amount: tributeDemand(vc ? stockOf(vc) : {}, "wood") }));
    }
  }
  const researchQueued = pendingJobs.filter((j) => j.kind === "research").length;
  const researching = researchQueued >= 3;
  const queueLen = (regionId: string) => pendingJobs.filter((j) => j.regionId === regionId).length;
  const ownedIds = owned.map((r) => r.regionId);
  const matchDay = ((now.getTime() - m.startsAt.getTime()) / 86400_000) * m.speed;
  // Where this tribe stands: hard tribes that fall behind the leader take more risks (raids, expeditions, hired swords).
  const standings = await db.select({ owner: matchRegions.ownerPlayerId, n: sql<number>`count(*)::int` }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), sql`${matchRegions.ownerPlayerId} is not null`)).groupBy(matchRegions.ownerPlayerId);
  const leader = Math.max(...standings.map((s) => s.n), 1);
  const isBehind = tier.scoresTargets && leader - owned.length > 2;
  const behind = isBehind ? 1.5 : 1;
  const leaderId = standings.length ? [...standings].sort((a, b) => b.n - a.n)[0]!.owner : null;
  // The tech that opens the next age, and what it costs today: the economy and the market keep it in view.
  const ageTech = TECHS.find((t) => t.advancesTo === p.age + 1);
  const ageTechCost = ageTech ? techCost(ageTech, matchDay) : null;

  // Threats: hostile armies heading for my regions (medium and hard react).
  const threatened = new Set<string>();
  if (tier.reactsToThreat) {
    const incoming = await db
      .select({ target: armies.targetRegionId })
      .from(armies)
      .where(and(eq(armies.matchId, m.id), eq(armies.status, "outbound"), inArray(armies.targetRegionId, ownedIds), inArray(armies.mission, ["raid", "conquer"]), sql`${armies.playerId} <> ${p.id}`));
    for (const i of incoming) threatened.add(i.target);
  }

  // The world's offers (medium and hard): mercenaries when an attack is coming or the iron is idle, a scouting
  // party into the unknown, peace with a stronger neighbour, and the last stand when the ice is a day from the capital.
  if (difficulty !== "easy") {
    const capital = owned.find((r) => r.regionId === p.capitalRegionId);
    if (capital && rng() < 0.5) {
      const iron = stockOf(capital).iron ?? 0;
      const budget = threatened.size > 0 || isBehind ? iron * 0.8 : iron * 0.3;
      const offers = await db
        .select()
        .from(mercenaryOffers)
        .where(and(eq(mercenaryOffers.matchId, m.id), isNull(mercenaryOffers.hiredBy), gt(mercenaryOffers.expiresAt, now)))
        .orderBy(mercenaryOffers.iron);
      const offer = offers.find((o) => o.iron >= 1 && o.iron <= budget);
      if (offer && (threatened.size > 0 || isBehind || iron > 200)) await attempt(() => db.transaction((tx) => hireMercenaries(tx, m, p, offer.id, now)));
    }
    // Expeditions: hard tribes often, medium tribes now and then; a tribe that is behind sends more.
    if (rng() < (difficulty === "hard" ? (isBehind ? 0.15 : 0.06) : 0.03)) {
      const strongest = [...owned].sort((a, b) => b.popSoldiers - a.popSoldiers)[0];
      // Whatever soldiers the age has (warriors early, legionaries later): three of the most numerous kind go.
      const soldierKinds = strongest ? Object.entries(strongest.units).filter(([id, n]) => n > 0 && !unitById.get(id)?.civilian && !unitById.get(id)?.naval && !unitById.get(id)?.hauler).sort((a, b) => b[1] - a[1]) : [];
      const [scoutKind, scoutHave] = soldierKinds[0] ?? ["", 0];
      if (strongest && scoutHave >= 9) {
        // Three to five hops out, somewhere unseen: the command refuses scouted land, so a few tries are cheap.
        let ring = new Set<string>([strongest.regionId]);
        const seen = new Set<string>(ring);
        const far: string[] = [];
        for (let i = 0; i < 5; i++) {
          const next = new Set<string>();
          for (const id of ring) for (const n of regionById(id)!.neighbors) if (!seen.has(n)) { seen.add(n); next.add(n); }
          ring = next;
          if (i >= 2) for (const id of ring) if (!ownedIds.includes(id)) far.push(id);
        }
        for (let tries = 0; tries < 6 && far.length; tries++) {
          const target = far[Math.floor(rng() * far.length)]!;
          if (await attempt(() => sendArmy(ctx, strongest.regionId, { mission: "expedition", targetRegionId: target, units: { [scoutKind]: 3 }, people: 0, cargo: {} }))) break;
        }
      }
    }
    if (temperament !== "raider" && rng() < 0.05) {
      const border = [...new Set(owned.flatMap((r) => regionById(r.regionId)!.neighbors))].filter((id) => !ownedIds.includes(id));
      const rows = border.length ? await db.select({ owner: matchRegions.ownerPlayerId }).from(matchRegions).where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, border), isNotNull(matchRegions.ownerPlayerId))) : [];
      const owners = [...new Set(rows.map((r) => r.owner!))].filter((id) => id !== p.id);
      const strong = owners.length ? (await db.select().from(players).where(and(inArray(players.id, owners), eq(players.hidden, false), isNull(players.eliminatedAt)))).filter((o) => o.score >= p.score) : [];
      const other = strong.sort((a, b) => b.score - a.score)[0];
      if (other && !(await areAllied(db, m.id, p.id, other.id))) await attempt(() => proposePact(db, m, p, other.id, "nap"));
    }
    if (!p.lastStandAt && p.capitalRegionId) {
      const capLat = Math.abs(regionById(p.capitalRegionId)!.lat);
      const freezeDay = freezeDayForLatitude(capLat) ?? 999;
      if (freezeDay - matchDay <= balance.events.lastStand.withinDays) {
        const dest = owned
          .filter((r) => !r.frozenAt && r.regionId !== p.capitalRegionId && Math.abs(regionById(r.regionId)!.lat) < capLat)
          .sort((a, b) => Math.abs(regionById(a.regionId)!.lat) - Math.abs(regionById(b.regionId)!.lat))[0];
        if (dest) await attempt(() => lastStand(db, m, p, dest.regionId));
      }
    }
  }

  // Ice: regions that freeze soon get evacuated to the safest owned region.
  const pendingSettle = await db
    .select({ target: armies.targetRegionId })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), eq(armies.mission, "settle"), eq(armies.status, "outbound")));
  const settlingTo = new Set(pendingSettle.map((a) => a.target));
  if (tier.iceRetreatDays > 0) await retreatFromIce(ctx, owned, matchDay, tier.iceRetreatDays, attempt, settlingTo, queueLen);

  for (const row of owned) {
    if (row.frozenAt) continue;
    const region = regionById(row.regionId)!;
    const { economy, rates } = projectRegion(row, now, m.speed, techFx);
    const pop = economy.popWorkers + economy.popSoldiers + economy.popOccupiers;
    const underThreat = threatened.has(row.regionId);

    // Buildings: walls first when threatened, otherwise the priority list.
    let slots = balance.queue.slotsPerRegion - queueLen(row.regionId);
    const avail = new Map(availableBuildings(p.age, techs).map((b) => [b.id, b]));
    const order = [...BUILD_ORDER];
    // The race for the wonder: once the age allows it, a hard tribe's capital builds the Great Hearth before anything else.
    if (row.isCapital && difficulty === "hard" && p.age >= (buildingById.get(balance.win.wonderBuilding)?.age ?? 99)) order.unshift(balance.win.wonderBuilding);
    if (underThreat) order.unshift("walls", "palisade");
    if (pop / economy.capacity > 0.75) order.unshift("huts");
    if (economy.food > economy.storage.food * 0.85 || economy.wood > economy.storage.wood * 0.85) order.unshift("storehouse");
    let wanted: Cost | null = null;
    for (const id of order) {
      const def = avail.get(id);
      if (!def) continue;
      if (buildingBlockedBy(def, region, row.buildings, row.isCapital)) continue;
      const level = row.buildings[id] ?? 0;
      if (level >= Math.min(def.maxLevel, tier.buildCap(p.age))) continue;
      const cost = buildingCost(def, level + 1, matchDay, region.neighbors.length);
      if (!wanted) wanted = cost;
      if (slots <= 0) break;
      if (tier.hoards && !comfortablyAffordable(economy, cost)) continue;
      // AI tribes may have one build per region waiting on materials, so their late-game queues do not go dead.
      const waitingHere = pendingJobs.some((j) => j.regionId === row.regionId && j.kind === "build" && j.waitingFor);
      if (await attempt(() => queueBuild(ctx, row.regionId, id, { allowWait: !waitingHere, maxOwed: balance.ai.maxWaitingShipment }))) slots -= 1;
      else if (rng() < 0.5) break;
    }

    // Economy: hard tribes steer workers toward what the next building needs; others use a fixed split.
    // Hard tribes with nothing to build steer toward the next age instead of a fixed split, so a quiet tribe never stalls at age 2.
    if (tier.adaptiveResearch && !wanted && ageTechCost && !techs.has(ageTech!.id)) wanted = ageTechCost;
    const want = tier.adaptiveEconomy && wanted ? steerToward(economy, rates, wanted) : rates.food < 0 || economy.food < 60 ? { food: 0.7, wood: 0.2, stone: 0.1 } : { food: 0.3, wood: 0.4, stone: 0.3 };
    const cur = normalizeAssignment(row.assignment);
    if (Math.abs(cur.food - want.food) > 0.05 || Math.abs(cur.stone - want.stone) > 0.05 || Math.abs(cur.wood - want.wood) > 0.05) {
      await attempt(() =>
        db.transaction(async (tx) => {
          await settleAndLockRegion(tx, m.id, row.regionId, now, m.speed);
          await tx.update(matchRegions).set({ assignment: want }).where(and(eq(matchRegions.matchId, m.id), eq(matchRegions.regionId, row.regionId)));
        }),
      );
    }

    // Caravans: once a store nears its cap, keep a couple of caravans here so overflow and trade routes can run.
    const nearCap = (["food", "wood", "stone"] as const).some((k) => economy[k] >= economy.storage[k] * 0.85);
    const wantCaravans = balance.ai.caravansPerRegion + (difficulty === "hard" ? 1 : 0);
    const haulerKinds = availableUnits(p.age, techs).filter((u) => u.hauler).sort((a, b) => b.carry - a.carry);
    const bestKind = haulerKinds[0]?.id ?? "caravan";
    const caravansQueued = pendingJobs.some((j) => j.regionId === row.regionId && j.kind === "train" && unitById.get(j.refId ?? "")?.hauler);
    if (nearCap && haulerCount(row.units) < wantCaravans && !caravansQueued && queueLen(row.regionId) < balance.queue.slotsPerRegion && economy.popWorkers > 12) {
      await attempt(() => queueTrain(ctx, row.regionId, bestKind, wantCaravans - haulerCount(row.units)));
    }

    // Soldiers: keep a share under arms; double it while threatened.
    // The capital is the realm: losing it loses the game, so it keeps twice the usual garrison.
    const share = (balance.ai.soldierShare[temperament] ?? 0.2) * (underThreat ? 2 : 1) * (row.regionId === p.capitalRegionId ? 2 : 1);
    if (queueLen(row.regionId) < balance.queue.slotsPerRegion && economy.popSoldiers < pop * share && economy.popWorkers > 8) {
      const units = availableUnits(p.age, techs).filter((u) => !u.naval && !u.civilian && (!u.needsResource || region.resources.includes(u.needsResource)));
      const engine = [...units].filter((u) => (u.breach ?? 0) > 0).sort((a, b) => (b.breach ?? 0) - (a.breach ?? 0))[0];
      const enginesHere = Object.entries(row.units).reduce((acc, [id, n]) => acc + ((unitById.get(id)?.breach ?? 0) > 0 ? n : 0), 0);
      // One engine for every eight soldiers, so walls never stop an attack cold.
      const wantEngines = engine && !underThreat && enginesHere < Math.max(2, Math.floor(economy.popSoldiers / 8)) && difficulty !== "easy";
      const best = wantEngines ? engine : [...units].filter((u) => !(u.breach ?? 0)).sort((a, b) => b.attack + b.defense - (a.attack + a.defense))[0];
      const qty = wantEngines ? Math.max(1, Math.min(6, Math.floor(economy.popSoldiers / 8) - enginesHere)) : Math.max(1, Math.min(underThreat ? 20 : 10, Math.floor(economy.popWorkers * (underThreat ? 0.3 : 0.15))));
      if (best) await attempt(() => queueTrain(ctx, row.regionId, best.id, qty));
    }
  }

  // Reinforce a threatened region from the strongest other region (medium and hard).
  if (threatened.size && owned.length > 1) {
    for (const target of threatened) {
      const donor = owned
        .filter((r) => r.regionId !== target && !threatened.has(r.regionId))
        .sort((a, b) => b.popSoldiers - a.popSoldiers)[0];
      if (!donor || donor.popSoldiers < 4) continue;
      const send: Record<string, number> = {};
      for (const [id, n] of Object.entries(donor.units)) send[id] = Math.floor(n * 0.6);
      await attempt(() => sendArmy(ctx, donor.regionId, { mission: "move", targetRegionId: target, units: send, people: 0, cargo: {} }));
    }
  }

  // Research: hard tribes jump on age advances; easy tribes only research with a comfortable surplus.
  if (!researching) {
    const queuedTechs = new Set(pendingJobs.filter((j) => j.kind === "research").map((j) => j.refId ?? ""));
    const known = new Set([...techs, ...queuedTechs]);
    const avail = availableTechs(p.age, known).filter((t) => !queuedTechs.has(t.id));
    const ids = new Set(avail.map((t) => t.id));
    // Every tier works toward the next age along the tree; the age tech itself waits for its day, its prerequisites do not.
    let next: string | undefined;
    if (ageTech) {
      const want: string[] = [];
      const walk = (id: string) => {
        if (known.has(id) || want.includes(id)) return;
        for (const r of techById.get(id)?.requires ?? []) walk(r);
        want.push(id);
      };
      walk(ageTech.id);
      next = want.find((id) => ids.has(id) && (process.env.NO_AGE_DAYS === "1" || (techById.get(id)?.earliestDay ?? 0) <= matchDay));
    }
    // Research never idles: if the tech on the path cannot be paid for yet, the cheapest other tech is researched meanwhile.
    const order: string[] = [];
    if (next) order.push(next);
    for (const t of RESEARCH_ORDER) if (ids.has(t) && !order.includes(t)) order.push(t);
    for (const t of [...avail].sort((a, b) => a.baseSeconds - b.baseSeconds)) if (!order.includes(t.id)) order.push(t.id);
    const capital = owned.find((r) => r.regionId === p.capitalRegionId) ?? owned[0]!;
    const { economy } = projectRegion(capital, now, m.speed, techFx);
    let tries = 0;
    for (const id of order) {
      if (tries >= 3) break;
      const def = techById.get(id)!;
      // Hoarders wait for a cushion on side techs, never on the path to the next age: an easy tribe still leaves the Bronze Age.
      if (tier.hoards && id !== next && !comfortablyAffordable(economy, techCost(def, matchDay))) continue;
      tries += 1;
      if (await attempt(() => queueResearch(ctx, id))) break;
    }
  }

  // Expansion: a crowded region trains settlers and claims the nearest free land. One colony at a time.
  if (tier.settles && settlingTo.size === 0) {
    const crowded = [...owned].filter((r) => !r.frozenAt && r.popWorkers >= balance.ai.settleAbove).sort((a, b) => b.popWorkers - a.popWorkers);
    for (const row of crowded) {
      const settlers = row.units.settler ?? 0;
      const need = balance.settle.settlersRequired;
      if (settlers >= need) {
        const free = await freeFrontier(db, m.id, ownedIds, (id) => (freezeDayForLatitude(Math.abs(regionById(id)!.lat)) ?? 999) - matchDay > 6);
        const target = free.sort((a, b) => distanceKm(row.regionId, a) - distanceKm(row.regionId, b))[0];
        if (target && (await attempt(() => sendArmy(ctx, row.regionId, { mission: "settle", targetRegionId: target, units: { settler: need }, people: 0, cargo: {} })))) break;
      } else if (!pendingJobs.some((j) => j.regionId === row.regionId && j.kind === "train") && queueLen(row.regionId) < balance.queue.slotsPerRegion) {
        if (await attempt(() => queueTrain(ctx, row.regionId, "settler", need))) break;
      }
    }
  }

  // Ore for sale: a tribe sitting on more ore than it needs lists half of it for wood.
  await sellOre(ctx, owned, now, matchDay);
  // Ore to buy: short of the ore the next age needs, buy the cheapest open offer with the capital's wood.
  if (!tier.hoards) await buyOre(ctx, owned, matchDay);

  // Aggression: raid or conquer a weak neighbour. Hard tribes get hungrier when they fall behind.
  const raidChance = (balance.ai.raidChance[temperament] ?? 0.15) * tier.aggression * behind * persona.aggression;
  const conquerChance = (balance.ai.conquerChance[temperament] ?? 0.2) * tier.aggression * behind * persona.aggression;
  const inFlight = await db
    .select({ id: armies.id })
    .from(armies)
    .where(and(eq(armies.matchId, m.id), eq(armies.playerId, p.id), inArray(armies.status, ["outbound", "returning"])));
  const maxInFlight = difficulty === "hard" ? 3 : 2;
  if (inFlight.length < maxInFlight && threatened.size === 0) {
    const roll = rng();
    // A bold strike ignores the usual odds now and then (medium and hard only): the one time a cautious tribe surprises you.
    const boldStrike = difficulty !== "easy" && rng() < persona.boldStrike;
    if (roll < raidChance + conquerChance || boldStrike) {
      const wantConquer = boldStrike ? rng() < 0.5 : roll >= raidChance;
      const strong = [...owned].sort((a, b) => b.popSoldiers - a.popSoldiers)[0]!;
      const soldiers = Object.values(strong.units).reduce((a, b) => a + b, 0);
      if (soldiers >= 6) {
        // Open bounties: a priced region or head is worth more, and hard tribes will go two hops further for one.
        const openBounties = await db.select().from(bounties).where(and(eq(bounties.matchId, m.id), isNull(bounties.claimedBy), sql`(${bounties.expiresAt} is null or ${bounties.expiresAt} > ${now.toISOString()}::timestamptz)`));
        const bountyOnRegion = new Map<string, number>();
        const bountyOnPlayer = new Map<string, number>();
        for (const b of openBounties) {
          const worth = Object.values(b.amount as Record<string, number>).reduce((a, v) => a + v, 0);
          if (b.regionId) bountyOnRegion.set(b.regionId, (bountyOnRegion.get(b.regionId) ?? 0) + worth);
          if (b.playerId) bountyOnPlayer.set(b.playerId, (bountyOnPlayer.get(b.playerId) ?? 0) + worth);
        }
        const reach = tier.reach + (matchDay >= 10 ? 1 : 0);
        const extra = tier.scoresTargets && bountyOnRegion.size > 0 ? 2 : 0;
        let ring = new Set<string>([strong.regionId]);
        const seen = new Set<string>(ring);
        const within = new Set<string>(ring);
        for (let i = 0; i < reach + extra; i++) {
          const next = new Set<string>();
          for (const id of ring) for (const n of regionById(id)!.neighbors) if (!seen.has(n)) { seen.add(n); next.add(n); }
          ring = next;
          for (const id of ring) if (i < reach || bountyOnRegion.has(id)) within.add(id);
        }
        const candidatesIds = [...within].filter((id) => !ownedIds.includes(id));
        const rows = await db
          .select()
          .from(matchRegions)
          .where(and(eq(matchRegions.matchId, m.id), inArray(matchRegions.regionId, candidatesIds)));
        const byId = new Map(rows.map((r) => [r.regionId, r]));
        const ownerIds = [...new Set(rows.map((r) => r.ownerPlayerId).filter((x): x is string => !!x))];
        const owners = ownerIds.length ? await db.select().from(players).where(inArray(players.id, ownerIds)) : [];
        const ownerById = new Map(owners.map((o) => [o.id, o]));
        // What this tribe would send: the wall bonus it faces depends on the siege engines in that force.
        const sendShare = strong.regionId === p.capitalRegionId ? 0.5 : difficulty === "hard" ? 0.8 : 0.7;
        const force: Record<string, number> = {};
        for (const [id, n] of Object.entries(strong.units)) if (!unitById.get(id)?.civilian && !unitById.get(id)?.naval) force[id] = Math.floor(n * sendShare);
        const siegeHave = breachOf(force);
        const candidates: Array<{ id: string; defenders: number; score: number; siegeNeed: number }> = [];
        for (const n of candidatesIds) {
          const r = byId.get(n);
          const owner = r?.ownerPlayerId ?? null;
          if (owner === p.id) continue;
          if (owner && (await areAllied(db, m.id, p.id, owner))) continue;
          const o = owner ? ownerById.get(owner) : null;
          if (o?.protectionUntil && o.protectionUntil.getTime() > now.getTime()) continue;
          if (wantConquer && owner && !o?.isAi && !tier.conquersHumans) continue;
          const effects = r ? effectsOf(r.buildings) : null;
          // Walls count in full against men alone; the engines in the force bring them down.
          const wallFull = r ? Object.keys(balance.combat.wallBreach).reduce((acc, id) => acc + (buildingById.get(id)?.effect.defense ?? 0) * (r.buildings[id] ?? 0), 0) : 0;
          const wallFaced = r ? wallBonusAgainst(r.buildings, force) : 0;
          const siegeNeed = r ? Object.entries(balance.combat.wallBreach).reduce((acc, [id, need]) => acc + ((r.buildings[id] ?? 0) >= 1 ? need : 0), 0) : 0;
          const defenders = r ? Object.values(r.units).reduce((a, b) => a + b, 0) * (1 + (effects?.defense ?? 0) - wallFull + wallFaced) + (r.popWorkers / 10) * balance.combat.militiaPerTenPeople : 0;
          // Late on, hard raiders go for the weak land other players hold rather than empty tundra.
          const playerLand = owner && matchDay >= balance.ai.conquerPlayersFromDay && difficulty === "hard" && temperament === "raider" ? 2.5 : 1;
          const ratio = balance.ai.maxTargetStrengthRatio * persona.boldness * (boldStrike ? 1.8 : 1) * (playerLand > 1 ? 1.4 : 1);
          if (defenders > soldiers * ratio) continue;
          const loot = r ? Math.max(0, r.food + r.wood + r.stone - 3 * (effects?.protect ?? 0)) : 0;
          const dist = distanceKm(strong.regionId, n);
          // Grudge: the leader's land looks sweeter to tribes that resent being behind.
          const grudge = owner && owner === leaderId && owner !== p.id ? 1 + persona.grudge : 1;
          const human = o && !o.isAi ? 1 + persona.grudge * 0.5 : 1;
          // A bounty counts as loot for a raid and as a reason to go for a conquest; every tier sees it.
          const bounty = (bountyOnRegion.get(n) ?? 0) + (owner ? bountyOnPlayer.get(owner) ?? 0 : 0);
          const score = tier.scoresTargets || boldStrike ? ((wantConquer ? regionById(n)!.value * 1000 + bounty * 2 : loot + bounty) / (defenders + 1) / (1 + dist / 1000)) * grudge * human * (wantConquer ? playerLand : 1) : -defenders * (2 - grudge * human) + bounty / 20;
          candidates.push({ id: n, defenders, score, siegeNeed });
        }
        candidates.sort((a, b) => b.score - a.score);
        let target = candidates[0];
        // Walled target, not enough engines: build siege first (medium and hard), or pick an open target instead.
        if (target && target.siegeNeed * 0.6 > siegeHave && difficulty !== "easy") {
          const engines = availableUnits(p.age, techs).filter((u) => (u.breach ?? 0) > 0 && !u.naval).sort((a, b) => (b.breach ?? 0) - (a.breach ?? 0));
          const engine = engines[0];
          const canQueue = queueLen(strong.regionId) < balance.queue.slotsPerRegion && !pendingJobs.some((j) => j.regionId === strong.regionId && j.kind === "train" && (unitById.get(j.refId ?? "")?.breach ?? 0) > 0);
          if (engine && canQueue) {
            const qty = Math.min(20, Math.max(1, Math.ceil((target.siegeNeed - siegeHave) / (engine.breach ?? 1))));
            await attempt(() => queueTrain(ctx, strong.regionId, engine.id, qty));
          }
          target = candidates.find((c) => c.siegeNeed * 0.6 <= siegeHave) ?? (boldStrike ? target : undefined);
        }
        if (target) {
          const send: Record<string, number> = { ...force };
          const need = balance.conquest.occupiersRequired;
          if (wantConquer) {
            if ((strong.units.settler ?? 0) >= need) {
              send.settler = need;
              await attempt(() => sendArmy(ctx, strong.regionId, { mission: "conquer", targetRegionId: target.id, units: send, people: 0, cargo: {} }));
            } else if (queueLen(strong.regionId) < balance.queue.slotsPerRegion && !pendingJobs.some((j) => j.regionId === strong.regionId && j.kind === "train")) {
              await attempt(() => queueTrain(ctx, strong.regionId, "settler", need));
            }
          } else {
            await attempt(() => sendArmy(ctx, strong.regionId, { mission: "raid", targetRegionId: target.id, units: send, people: 0, cargo: {} }));
          }
        }
      }
    }
  }

  const { min, max } = tier.cadence;
  const minutes = min + rng() * (max - min);
  await db.update(players).set({ nextAiAt: new Date(now.getTime() + (minutes * 60 * 1000) / m.speed) }).where(eq(players.id, p.id));
}

function comfortablyAffordable(e: { food: number; wood: number; stone: number; special: Record<string, number> }, cost: Cost): boolean {
  const stock: Record<string, number> = { food: e.food, wood: e.wood, stone: e.stone, ...e.special };
  return Object.entries(cost).every(([k, v]) => (stock[k] ?? 0) >= v * 2);
}

/** Worker split that closes the gap to `wanted` fastest, keeping food non-negative. */
function steerToward(e: { food: number; wood: number; stone: number }, rates: { food: number }, wanted: Cost): { food: number; wood: number; stone: number } {
  const deficit = { food: Math.max(0, (wanted.food ?? 0) - e.food), wood: Math.max(0, (wanted.wood ?? 0) - e.wood), stone: Math.max(0, (wanted.stone ?? 0) - e.stone) };
  const total = deficit.food + deficit.wood + deficit.stone;
  if (total <= 0) return rates.food < 0 ? { food: 0.5, wood: 0.3, stone: 0.2 } : { food: 0.3, wood: 0.4, stone: 0.3 };
  const split = { food: 0.15 + 0.7 * (deficit.food / total), wood: 0.075 + 0.7 * (deficit.wood / total), stone: 0.075 + 0.7 * (deficit.stone / total) };
  if (rates.food < 0 || e.food < 100) split.food = Math.max(split.food, 0.45);
  return normalizeAssignment(split);
}

/** Move people, units and goods out of regions about to freeze into the safest owned region. */
async function retreatFromIce(
  ctx: CommandContext,
  owned: MatchRegionRow[],
  matchDay: number,
  horizonDays: number,
  attempt: (fn: () => Promise<unknown>) => Promise<boolean>,
  settlingTo: Set<string>,
  queueLen: (regionId: string) => number,
): Promise<void> {
  const { db, m } = ctx;
  const safety = (id: string) => freezeDayForLatitude(Math.abs(regionById(id)!.lat)) ?? 999;
  const safe = owned.filter((r) => !r.frozenAt && safety(r.regionId) - matchDay > horizonDays + 5).sort((a, b) => safety(b.regionId) - safety(a.regionId));
  if (!safe.length) {
    // Nowhere safe yet: the most threatened region sends (or trains) settlers toward safer free land.
    if (settlingTo.size > 0) return;
    const threatened = owned.filter((r) => !r.frozenAt && safety(r.regionId) - matchDay <= horizonDays + 3).sort((a, b) => safety(a.regionId) - safety(b.regionId));
    const row = threatened[0];
    if (!row) return;
    const need = balance.settle.settlersRequired;
    if ((row.units.settler ?? 0) >= need) {
      const free = await freeFrontier(db, m.id, owned.map((r) => r.regionId), (id) => safety(id) - matchDay > horizonDays + 8);
      const target = free.sort((a, b) => safety(b) - safety(a) || distanceKm(row.regionId, a) - distanceKm(row.regionId, b))[0];
      if (target) await attempt(() => sendArmy(ctx, row.regionId, { mission: "settle", targetRegionId: target, units: { settler: need }, people: 0, cargo: {} }));
    } else if (queueLen(row.regionId) < balance.queue.slotsPerRegion) {
      await attempt(() => queueTrain(ctx, row.regionId, "settler", need));
    }
    return;
  }
  for (const row of owned) {
    if (row.frozenAt) continue;
    if (safety(row.regionId) - matchDay > horizonDays) continue;
    const dest = safe.sort((a, b) => distanceKm(row.regionId, a.regionId) - distanceKm(row.regionId, b.regionId))[0]!;
    if (dest.regionId === row.regionId) continue;
    const people = Math.floor(row.popWorkers * 0.8);
    const cargo: Record<string, number> = { food: Math.floor(row.food * 0.8), wood: Math.floor(row.wood * 0.8), stone: Math.floor(row.stone * 0.8) };
    const units = { ...row.units };
    if (people < 1 && Object.values(units).every((n) => n <= 0)) continue;
    await attempt(() => sendArmy(ctx, row.regionId, { mission: Object.values(units).some((n) => n > 0) ? "move" : "transport", targetRegionId: dest.regionId, units, people, cargo }));
  }
}

/** Unowned, uninhabited, non-tundra regions next to mine (optionally filtered), for settling. */
async function freeFrontier(db: Db, matchId: string, ownedIds: string[], ok: (id: string) => boolean = () => true): Promise<string[]> {
  const ids = [...new Set(ownedIds.flatMap((id) => regionById(id)?.neighbors ?? []))].filter((id) => !ownedIds.includes(id) && !regionById(id)!.terrain.startsWith("tundra") && ok(id));
  if (ids.length === 0) return [];
  const rows = await db
    .select({ regionId: matchRegions.regionId, owner: matchRegions.ownerPlayerId, pop: sql<number>`${matchRegions.popWorkers} + ${matchRegions.popSoldiers} + ${matchRegions.popOccupiers}` })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, matchId), inArray(matchRegions.regionId, ids)));
  const taken = new Set(rows.filter((r) => r.owner || r.pop >= 1).map((r) => r.regionId));
  return ids.filter((id) => !taken.has(id));
}

/** List surplus ore on the market so other tribes (and humans) can buy their way into the next age. */
async function sellOre(ctx: CommandContext, owned: MatchRegionRow[], now: Date, matchDay: number): Promise<void> {
  const { db, m, p } = ctx;
  // The next age costs ore too: that much stays home across the realm, so a peaceful tribe does not sell the iron it needs for Drill.
  const next = availableTechs(p.age, ctx.techs).find((t) => t.advancesTo !== undefined) ?? TECHS.find((t) => t.advancesTo === p.age + 1);
  const reserve: Record<string, number> = next ? techCost(next, matchDay) : {};
  const pooled: Record<string, number> = {};
  for (const r of owned) for (const [k, v] of Object.entries(r.special as Record<string, number>)) pooled[k] = (pooled[k] ?? 0) + v;
  const open = await db
    .select({ offer: marketOrders.offerResource })
    .from(marketOrders)
    .where(and(eq(marketOrders.matchId, m.id), eq(marketOrders.playerId, p.id), eq(marketOrders.status, "open")));
  if (open.length >= 3) return;
  const listed = new Set(open.map((o) => o.offer));
  for (const row of owned) {
    if (row.frozenAt) continue;
    for (const ore of ["copper", "tin", "iron"] as const) {
      if (listed.has(ore)) continue;
      const have = (row.special as Record<string, number>)[ore] ?? 0;
      if (have <= balance.ai.oreListAbove) continue;
      const spare = Math.max(0, (pooled[ore] ?? 0) - (reserve[ore] ?? 0));
      const amount = Math.min(Math.floor(have / 2), Math.floor(spare));
      if (amount < 1) continue;
      pooled[ore] = (pooled[ore] ?? 0) - amount;
      try {
        await db.transaction(async (tx) => {
          const locked = await settleAndLockRegion(tx, m.id, row.regionId, now, m.speed);
          if ((stockOf(locked)[ore] ?? 0) < amount) return;
          await applyCost(tx, locked, { [ore]: amount });
          await tx.insert(marketOrders).values({
            matchId: m.id,
            playerId: p.id,
            regionId: row.regionId,
            offerResource: ore,
            offerAmount: amount,
            askResource: "wood",
            askAmount: amount * balance.ai.oreAskWoodPerUnit,
            status: "open",
          });
        });
        listed.add(ore);
      } catch {
        // Market full or region changed hands; try again next pass.
      }
    }
  }
}

/** Buy ore on the market when the next age advance needs more than the tribe holds. One purchase per pass. */
async function buyOre(ctx: CommandContext, owned: MatchRegionRow[], matchDay: number): Promise<void> {
  const { db, m, p, techs } = ctx;
  const next = availableTechs(p.age, techs).find((t) => t.advancesTo !== undefined);
  if (!next) return;
  const cost = techCost(next, matchDay);
  const capital = owned.find((r) => r.regionId === p.capitalRegionId);
  if (!capital || capital.frozenAt) return;
  const pooled: Record<string, number> = {};
  for (const r of owned) for (const [k, v] of Object.entries(r.special as Record<string, number>)) pooled[k] = (pooled[k] ?? 0) + v;
  for (const ore of ["copper", "tin", "iron"] as const) {
    const need = (cost[ore] ?? 0) - (pooled[ore] ?? 0);
    if (need <= 0) continue;
    const offers = await db
      .select()
      .from(marketOrders)
      .where(and(eq(marketOrders.matchId, m.id), eq(marketOrders.status, "open"), eq(marketOrders.offerResource, ore), sql`${marketOrders.playerId} <> ${p.id}`));
    const stock = stockOf(capital);
    const affordable = offers
      .filter((o) => (stock[o.askResource] ?? 0) >= o.askAmount && (stock[o.askResource] ?? 0) - o.askAmount > 2000)
      .sort((a, b) => a.askAmount / a.offerAmount - b.askAmount / b.offerAmount);
    const pick = affordable[0];
    if (!pick) continue;
    try {
      await acceptMarketOrder(db, m, p, pick.id, capital.regionId);
    } catch {
      // Someone else got it first, or the seller changed; try again next pass.
    }
    return;
  }
}

/** A tribe's fixed streak for the match: aggression 0.6..1.6, boldness 0.7..1.6 (hard up to 2.0), grudge 0..1, bold-strike chance per decision. */
function personaOf(seed: string, playerId: string, difficulty: Difficulty): { aggression: number; boldness: number; grudge: number; boldStrike: number } {
  const r = seededRng(`${seed}:persona:${playerId}`);
  const aggression = 0.6 + r() * 1.0;
  const boldness = 0.7 + r() * (difficulty === "hard" ? 1.3 : 0.9);
  const grudge = r();
  const boldStrike = difficulty === "hard" ? 0.08 + r() * 0.12 : difficulty === "medium" ? 0.03 + r() * 0.07 : 0;
  return { aggression, boldness, grudge, boldStrike };
}
