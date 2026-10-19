import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePageMeta } from "../seo.js";
import { AGES, balance } from "@lastthaw/shared";
import { Card } from "../components/ui.js";
import { BuildingList, TechTree, UnitList } from "../components/Reference.js";
import { TechTreeGraph } from "../components/TechTreeGraph.js";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const mult = (x: number) => `${x}x`;
const eco = balance.economy;
const ev = balance.events;

/** The numbers behind the rules, read straight from the balance config so this page never drifts from the game. */
const ADVANCED: Array<{ title: string; body: React.ReactNode }> = [
  {
    title: "How your people grow",
    body: (
      <>
        <p>
          Every game hour a fed region gains <b>{pct(eco.growthPerHour)} of its population plus {eco.arrivalsPerHour} newcomers</b>, scaled by how much room is left and by your growth techs. Room is 1 minus
          population over capacity, so growth slows as the region fills and stops at capacity. Capacity starts at {eco.baseCapacity} and rises with Huts, Farms, Aqueducts and some techs.
        </p>
        <p className="mt-2">
          Growth techs stack: Herbal medicine +20%, Vaccination +40%, Sanitation +20%, Antibiotics +40%. No building speeds growth; buildings only add capacity or food. Only workers grow;
          soldiers and occupiers are fixed headcounts.
        </p>
        <p className="mt-2">
          A region above capacity sends {pct(eco.migrationPerHour)} of the overflow per hour to a neighbouring region of yours with room. Above {mult(ev.plague.crowding)} capacity it may catch
          plague: no growth and {pct(ev.plague.deathPerHour)} of its people lost per hour for {ev.plague.hours} hours. Plague resistance from the medicine techs lowers the odds.
        </p>
      </>
    ),
  },
  {
    title: "Food, hunger and death",
    body: (
      <>
        <p>
          Each person eats <b>{eco.foodPerPersonPerHour} food an hour</b>; a soldier eats {eco.soldierFoodMultiplier} times that. A region with no food in store and a negative balance is starving: no growth, and{" "}
          {pct(eco.starvationPerHour)} of its people die each hour. A frozen region loses {pct(eco.frozenDeathPerHour)} an hour; nothing survives the ice.
        </p>
        <p className="mt-2">
          Base output per worker per hour is {eco.perWorkerPerHour.food} food, {eco.perWorkerPerHour.wood} wood and {eco.perWorkerPerHour.stone} stone before terrain, so one food worker feeds about{" "}
          {Math.floor(eco.perWorkerPerHour.food / eco.foodPerPersonPerHour)} people on plain ground. Coastal and river regions add {pct(eco.coastalFoodBonus - 1)} food each.
        </p>
      </>
    ),
  },
  {
    title: "Terrain and special resources",
    body: (
      <>
        <p>Terrain multiplies what a worker gathers, and how long it takes to march into. Pick capitals and colonies for what you lack.</p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-1 pr-3">Terrain</th>
                <th className="py-1 pr-3">Food</th>
                <th className="py-1 pr-3">Wood</th>
                <th className="py-1 pr-3">Stone</th>
                <th className="py-1">Travel</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {Object.entries(eco.terrain).map(([t, m]) => (
                <tr key={t} className="border-t border-slate-800">
                  <td className="py-1 pr-3 capitalize text-slate-200">{t}</td>
                  <td className="py-1 pr-3">{mult(m.food)}</td>
                  <td className="py-1 pr-3">{mult(m.wood)}</td>
                  <td className="py-1 pr-3">{mult(m.stone)}</td>
                  <td className="py-1">{mult(balance.travel.terrain[t] ?? 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2">
          Special resources stack on top: fertile soil {mult(eco.resourceBonus.fertile_soil!.food!)} food, fish {mult(eco.resourceBonus.fish!.food!)} food, timber {mult(eco.resourceBonus.timber!.wood!)} wood, a stone quarry{" "}
          {mult(eco.resourceBonus.stone_quarry!.stone!)} stone. Copper, tin, iron and horses produce nothing by themselves; a Mine or Stables turns them into stock, capped at {eco.specialStorage} per region.
        </p>
      </>
    ),
  },
  {
    title: "Why everything gets dearer",
    body: (
      <>
        <p>
          Building and research costs scale with the match day: {mult(balance.timers.dayCost[1]!.mult)} by day {balance.timers.dayCost[1]!.day} and {mult(balance.timers.dayCost[2]!.mult)} by day{" "}
          {balance.timers.dayCost[2]!.day}. Unit costs rise by the square root of the same curve. Income grows with your empire, so a thing bought early is always the cheapest it will ever be.
        </p>
        <p className="mt-2">
          Each building level costs {mult(balance.timers.costGrowth)} the last and takes {mult(balance.timers.levelGrowth)} as long; from level {balance.timers.lateLevel} both climb faster still. No single job runs longer
          than {balance.timers.maxSeconds / 3600} game hours. Training a batch of N units takes base time times N to the power {balance.timers.batchExponent}, so big batches are cheaper per unit than many small ones.
        </p>
        <p className="mt-2">
          Storage caps a region at {eco.baseStorage.food} food, {eco.baseStorage.wood} wood and {eco.baseStorage.stone} stone before Storehouses; the capital holds {eco.capitalStorageMult} times that. A full region
          sends {pct(balance.trade.overflowShare)} of its cap to the capital by caravan on its own.
        </p>
      </>
    ),
  },
  {
    title: "Travel times",
    body: (
      <>
        <p>
          Distance is real great-circle distance, scaled, at the speed of your slowest unit. Each leg is multiplied by the terrain being entered (table above); entering a coastal or river region is{" "}
          {mult(balance.travel.waterwayFactor)}. Roads at both ends make a leg {mult(balance.travel.roadBothFactor)}, at one end {mult(balance.travel.roadOneFactor)}; Railways at both ends {mult(balance.travel.railBothFactor)}.
          Allied roads and rails count as yours.
        </p>
        <p className="mt-2">
          Sea lanes open with Shipbuilding and run at {mult(balance.travel.seaFactor)}, or {mult(balance.travel.harborBothFactor)} with a Harbor at both ends. Every travelling person carries {balance.travel.carryPerPerson} goods. The
          defender sees your army the moment it leaves, with a countdown.
        </p>
      </>
    ),
  },
  {
    title: "How battles resolve",
    body: (
      <>
        <p>
          A battle lasts up to {balance.combat.maxRounds} rounds. Each side's strength swings by up to {pct(balance.combat.variance / 2)} either way each round, so a close fight can go either way; a lopsided one cannot.
          Unarmed people fight back a little: {balance.combat.militiaPerTenPeople} warrior-equivalents per ten people.
        </p>
        <p className="mt-2">
          Terrain favours the defender: hills +{pct(balance.combat.terrainDefense.hills!)}, forest and wetland +{pct(balance.combat.terrainDefense.forest!)}, mountains +{pct(balance.combat.terrainDefense.mountains!)}. Walls are strong against
          men alone but every siege point an attacker brings (catapults, cannon, artillery) erodes them: a Palisade is breached at {balance.combat.wallBreach.palisade}, Walls at {balance.combat.wallBreach.walls}, a Fort at{" "}
          {balance.combat.wallBreach.fort}, a Castle at {balance.combat.wallBreach.castle}. Terrain and techs are never breached.
        </p>
        <p className="mt-2">A successful raid takes up to {pct(balance.combat.raidShare)} of the unprotected stock. Storehouses and Granaries protect a share of it.</p>
      </>
    ),
  },
  {
    title: "Holding conquered land",
    body: (
      <>
        <p>
          A settled region starts at {pct(balance.settle.startingLoyalty)} loyalty; a conquered one at {pct(balance.conquest.startingLoyalty)}. Loyalty drifts {pct(balance.conquest.loyaltyRate)} an hour toward a target that falls with
          distance from your capital, reaching zero at {balance.conquest.distanceScaleKm.toLocaleString()} km. Roads, Temples and Forts raise the target, as does keeping {balance.conquest.occupiersPerHundred} occupiers per hundred people
          there; a Temple converts {balance.conquest.templeConvertsPerHour} workers an hour into occupiers until the need is met.
        </p>
        <p className="mt-2">
          Below {pct(balance.conquest.rebelBelow)} loyalty a region has a {pct(balance.conquest.rebelChancePerTick)} chance every {balance.tick.minutes} minutes to rebel: it goes neutral and expels your people. Moving the capital
          south also moves the loyalty centre with it.
        </p>
      </>
    ),
  },
  {
    title: "The ice, and what else the world throws at you",
    body: (
      <>
        <p>
          The ice line sits at {balance.ice.schedule[0]!.latitude}° on day 0 and reaches {balance.ice.schedule[balance.ice.schedule.length - 1]!.latitude}° on day 30, moving about ten degrees a week from both poles. A region
          starts suffering when the line touches its pole-facing tip: production tapers down to {pct(balance.ice.taperFloor)} by the time the line reaches the region's centre, and then it freezes.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Blizzards from day {ev.storm.fromDay}: a day of warning, then production halves and travel doubles across a wide band for {ev.storm.hours} hours.</li>
          <li>Thaw pockets between days {ev.thaw.fromDay} and {ev.thaw.toDay}: a region that should freeze stays open {ev.thaw.extraDays} days longer, at most {ev.thaw.max} times a match.</li>
          <li>Refugees: when a region freezes, {pct(ev.refugees.share)} of its people walk to the nearest empire within {ev.refugees.hops} hops, which has {ev.refugees.hours} hours to take them in.</li>
          <li>The Northern Horde from day {ev.horde.fromDay}: raids out of the ice line against the richest region in reach, growing by {ev.horde.perDay} warriors a day and bringing siege engines from day {ev.horde.catapultsFromDay}.</li>
          <li>Rich finds: a mine, quarry or camp doubles its output for {ev.boom.hours} hours, and the neighbours hear about it.</li>
          <li>Expeditions: send {ev.expedition.minSoldiers} or more soldiers {ev.expedition.minHops} or more hops into unknown land for a chance at an artifact, a hoard or a tale, or an ambush.</li>
        </ul>
      </>
    ),
  },
  {
    title: "How score is counted",
    body: (
      <p>
        Score is regions times {balance.win.scoreWeights.territory}, plus population times {balance.win.scoreWeights.population}, plus age times {balance.win.scoreWeights.age}. Being first in the match to an age is worth {balance.win.milestones.age}, the first
        Harbor {balance.win.milestones.harbor}, Temple {balance.win.milestones.temple}, Train {balance.win.milestones.train}, and the first to begin the Great Hearth {balance.win.milestones.wonder}. Below the winner, final rank is by score.
      </p>
    ),
  },
  {
    title: "World events: what happens to you",
    body: (
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <b>Blizzards</b>: from day {ev.storm.fromDay}, each day has a {pct(ev.storm.chance)} chance of one. Everyone within {ev.storm.radiusKm} km of its centre gets {ev.storm.warningHours} hours' warning; then production runs at {pct(ev.storm.production)} and travel takes {ev.storm.travel}x as long for {ev.storm.hours} hours.
        </li>
        <li>
          <b>Thaw pockets</b>: between days {ev.thaw.fromDay} and {ev.thaw.toDay}, with a {pct(ev.thaw.chance)} chance per ice step and at most {ev.thaw.max} per match, a valuable region about to freeze stays open {ev.thaw.extraDays} days longer. Everyone hears which.
        </li>
        <li>
          <b>Plague</b>: a region over {pct(ev.plague.crowding)} of its capacity rolls a {pct(ev.plague.chance)} chance each day. For {ev.plague.hours} hours it stops growing and loses {pct(ev.plague.deathPerHour)} of its people an hour. Herbal medicine halves the chance; Vaccination or Sanitation stop it.
        </li>
        <li>
          <b>Migrant columns</b>: when the ice takes a region, {pct(ev.refugees.share)} of its people walk to the nearest empire within {ev.refugees.hops} hops. The owner has {ev.refugees.hours} hours to take them in at {ev.refugees.foodPerPerson} food a head, or they are lost.
        </li>
        <li>
          <b>The Northern Horde</b>: from day {ev.horde.fromDay} a horde comes down out of the ice line with a {pct(ev.horde.chance)} chance each day ({pct(ev.horde.lateChance)} from day {ev.horde.lateDay}): {ev.horde.base} fighters plus {ev.horde.perDay} for every day after day {ev.horde.fromDay}, with siege engines from day {ev.horde.catapultsFromDay}. It raids the nearest held land within {ev.horde.reachKm} km. Walls and a garrison hold it; empty land does not. Its camp carries a bounty.
        </li>
        <li>
          <b>Rich finds</b>: each day a {pct(ev.boom.chance)} chance that one Mine, Quarry or Lumber camp somewhere doubles its output for {ev.boom.hours} hours. The neighbours are told, which makes it a target.
        </li>
        <li>
          <b>Mercenaries</b>: each day a {pct(ev.mercenaries.chance)} chance of one or two companies for hire, paid in iron ({ev.mercenaries.ironPerUnit.sellsword} a Sellsword, {ev.mercenaries.ironPerUnit.free_company} a Free Company man). Offers last {ev.mercenaries.offerHours} hours; the men serve {ev.mercenaries.hours} hours, then move on.
        </li>
        <li>
          <b>Expeditions</b>: at least {ev.expedition.minSoldiers} soldiers sent {ev.expedition.minHops} or more hops into land nobody has scouted. On arrival: {pct(ev.expedition.artifact)} a free tech, {pct(ev.expedition.hoard)} a hoard of iron ({ev.expedition.hoardIronPerAge} per age you have reached), {pct(ev.expedition.tale)} a tale that lifts loyalty by {Math.round(ev.expedition.taleLoyalty * 100)} across your realm for {ev.expedition.taleHours} hours, {pct(ev.expedition.ambush)} an ambush that costs half the party.
        </li>
        <li>
          <b>The last stand</b>: once per match, when the ice is {ev.lastStand.withinDays} day from your capital, everything in it marches at {ev.lastStand.speedMult}x speed to a region of yours nearer the equator, carry limits ignored. The capital moves when the column arrives.
        </li>
        <li>
          <b>Daily objectives</b>: each day has a prize of {balance.win.milestones.daily} score for the best tribe at it (most regions, people, food, coastal land, techs finished or battles won).
        </li>
        <li>
          <b>Bounties</b>: a region that rebels is worth {ev.bounty.rebelPerValue}x its value in food, wood and stone; a horde camp pays {ev.bounty.hordeCamp.food} food, {ev.bounty.hordeCamp.wood} wood and {ev.bounty.hordeCamp.stone} stone; a tribe that refuses tribute carries {pct(ev.bounty.tributeShare)} of its capital stock on its head for {ev.bounty.tributeHours} hours. Win a battle against the region or the player and the reward lands in your capital.
        </li>
      </ul>
    ),
  },
  {
    title: "Diplomacy: pacts, ceasefires and tribute",
    body: (
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <b>Non-aggression pact</b>: proposed from the Players tab, accepted in the Alliance menu. While it holds, neither side can raid, conquer or send expeditions against the other. Ending it takes {ev.diplomacy.napNoticeHours} hours' notice; attacks are refused until the notice runs out, so a pact cannot be broken by surprise.
        </li>
        <li>
          <b>Ceasefire</b>: the same protection for a fixed {ev.diplomacy.ceasefireHours} hours, then it simply ends.
        </li>
        <li>
          <b>Tribute</b>: demand a resource and an amount from another tribe; they have {ev.diplomacy.tributeHours} hours to pay it from their capital, and you may demand from the same tribe once every {ev.diplomacy.tributeCooldownHours} hours. A refusal gives you {ev.diplomacy.causeForWarHours} hours of cause for war, during which your raids on them carry {ev.diplomacy.lootMult}x loot, and puts a bounty on the refuser. AI tribes pay when the demand is under a tenth of their capital stock.
        </li>
        <li>
          <b>Alliances</b> are separate and stronger: shared vision, reinforcing and shipping goods to each other, private chat, and the chance to win together. Hordes respect nobody's pacts.
        </li>
      </ul>
    ),
  },
];

const steps: Array<{ title: string; body: string }> = [
  { title: "Join a match and pick a capital", body: "In the lobby you are offered a handful of starting regions, spread far from other players. Pick one, or let the game pick when the match starts. You begin with five families and a small store of food, wood and stone." },
  { title: "Set your workers", body: "Drag the three sliders to split your workers between food, wood and stone. Food feeds everyone and grows the population; wood and stone build everything else. The sliders always add up to 100%. Hover anything to see exactly what it will change." },
  { title: "Build and research", body: "Each region has a build queue with ten slots; research has a ten-deep queue of its own and draws ore and horses from any region you own, so nothing has to be hauled home. Resources are paid when you click. Huts raise your population capacity, Storehouses hold more, gathering buildings raise output. Fire making, Flint tools and Agriculture lead to Bronze working, which opens the next age." },
  { title: "Expand", body: "Train five Settlers and send them on a Settle mission to any empty region next to yours (dashed outlines on the map). They become its first workers. A region over its capacity sends part of the surplus each hour to neighbouring regions of yours that have room, so crowded land spreads out on its own. To take land someone already holds, send soldiers on a Conquer mission with at least five Settlers; the settlers stay out of the fight and occupy the region if you win. Colonies pay back with haulers: train caravans, upgrade them to Wagons (Bronze) and Trains (Medieval, with Railways on top of Roads) for far more capacity and speed, then set up a trade route under the region's Routes tab (fixed loads or a share of production) and they haul goods to your capital on a schedule. Research Road building, then build Roads once in a region to connect it to every neighbour: legs between two road regions are 40% faster, and roads show on the map." },
  { title: "Scout, mark and take notes", body: "Tap a region you know nothing about and, if Scouts are standing in a region of yours, you can send one with a tap. Only Scouts can scout: fast, cheap, trained from the first day. The report arrives in your inbox, where any message about a region, a scout report or a battle, has an Open region button; the pop-up for a new message has it too. It centres the map on the region, flashes it so your eye lands on it, and opens its panel, and it is also written into your notes on that region with the day and time, so you always know what you learned and when; things may have changed since. Every battle in a region goes into both sides' notes too: what each brought, what it cost, how it ended. Any region can carry your own notes and a coloured marker: the marker shows as a pin on the map, and nobody else ever sees your notes." },
  { title: "Fight", body: "Train soldiers from your workers. Raids steal unprotected stock; conquests take the region. Travel time depends on distance, terrain and your slowest unit, and the defender hears the moment you set out: a chime, a message naming the region, the rough size and the arrival time, and a red marker on the map with the countdown. A Watchtower (Stone Age, built once) keeps every region next to it in plain view, units and all, and shows the exact make-up of an attacking force once it reaches a region next to the tower's. Battles resolve themselves on arrival and both sides get a report. Walls, forts, hills and mountains favour the defender." },
  { title: "Hold what you take", body: "Lose your capital and you lose the game: whoever took it inherits every region you held, as freshly conquered land; if the ice or a rebellion took it, the realm breaks up into neutral tribes. Keep it garrisoned, and move it south ahead of the ice. Conquered land far from your capital drifts toward rebellion. Roads, Temples and Forts raise loyalty; so does keeping enough occupiers there. A region that rebels goes neutral and throws out your people." },
  { title: "Trade and ally", body: "The market lets you offer one resource for another; anyone can accept. Alliances share vision, let you reinforce and ship goods to each other, and chat privately. An alliance can win together. The chat chimes and shows a count whenever someone writes, even with the panel closed; mute a player from their message, or the whole chat, and undo it from the chat panel." },
  { title: "Watch the ice", body: "Toggle Ice forecast on the map to see the day each region freezes. Frozen regions stop producing and lose people, so move south before the line reaches you. Most of the map is gone by week four. When the ice is a day from your capital you may make a Last stand: once per match, everything you have in the capital marches south at double speed to a region of yours further from the pole." },
  { title: "Deal with the world", body: "Not everything that happens is someone's doing. Blizzards come with a day's warning and halve production while doubling travel. Plague breaks out in overcrowded regions (Herbal medicine halves the chance; Vaccination or Sanitation stop it). A rich find doubles a mine, quarry or camp for two days, and everyone hears which region it was. Thaw pockets keep a region open three days past its freeze. People fleeing the ice arrive at the nearest empire as a migrant column you can take in for food or turn away. From day 14 the Northern Horde raids out of the ice line; walls and a garrison hold it, empty land does not. Mercenary companies offer themselves for iron and move on after two days." },
  { title: "Talk before you fight", body: "From the Players tab you can propose a non-aggression pact (ending it takes a day's notice), a two-day ceasefire, or demand tribute. A refused tribute gives you a day of cause for war with double loot, and puts a bounty on the refuser's head. Send three or more soldiers on an Expedition to a far region nobody has scouted: they may bring back a free tech, a hoard of iron, a tale that lifts loyalty across your realm, or walk into an ambush." },
  { title: "Read the report", body: "Every finished match keeps a report at its own address, public and shareable: a written account of how it went, who led and when the lead changed hands, the biggest battle, how far the ice reached and who was eliminated; every tribe's thirty days in a line; the match day by day; the final standings and the firsts; and links to the replay, the full leaderboard and the tournaments on either side. Tournament results also feed the hall of fame: wins, losses, ties and points for every champion." },
  { title: "Chase the day's prize", body: "Every day has an objective (most regions, most people, biggest larder, most coastal land, most techs or most battles won) worth 100 score to the best player at the day's end. It sits in the bar above the map with its reward; tap it for yesterday's winner and the open bounties. Bounties appear on regions that rebel, on the Horde's camps and on players who refuse tribute; win a battle against them and the reward is delivered to your capital. The Leaderboard shows today's objective, open bounties and a timeline of everything that has happened in the match." },
];

type Tab = "basics" | "winning" | "advanced" | "techs" | "buildings" | "units";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "basics", label: "Basics" },
  { id: "winning", label: "Winning and tips" },
  { id: "advanced", label: "Advanced" },
  { id: "techs", label: "Tech tree" },
  { id: "buildings", label: "Buildings" },
  { id: "units", label: "Units" },
];

export function HowToPlayPage() {
  const [techView, setTechView] = useState<"graph" | "list">("graph");
  const [tab, setTab] = useState<Tab>(() => (typeof window !== "undefined" && TABS.some((t) => t.id === window.location.hash.slice(1)) ? (window.location.hash.slice(1) as Tab) : "basics"));
  useEffect(() => {
    if (typeof window !== "undefined") window.history.replaceState(null, "", tab === "basics" ? window.location.pathname : `#${tab}`);
  }, [tab]);
  usePageMeta({ title: "How to play", description: "The Last Thaw field manual: pick a capital, set your workers, build and research, expand and fight, hold your land, trade and ally, and watch the ice. Ten minutes to learn, thirty days to win.", path: "/how-to-play" });
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <header>
        <p className="mb-3 shadow-copy text-xs font-medium uppercase tracking-[0.25em] text-sky-300">Field manual</p>
        <h1 className="display text-4xl font-bold sm:text-5xl">
          <span className="frost-text">How to play</span>
        </h1>
        <p className="shadow-copy mt-3 text-lg text-slate-200">Ten minutes to learn, thirty days to win.</p>
      </header>

      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`rounded px-3 py-1.5 text-sm ${tab === t.id ? "bg-amber-400/20 text-amber-200" : "text-slate-300 hover:text-white"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "basics" && (
        <>
      <ol className="space-y-4">
        {steps.map((s, i) => (
          <li key={s.title}>
            <Card>
              <h2 className="display font-semibold text-white">
                <span className="mr-2 text-amber-300">{i + 1}.</span>
                {s.title}
              </h2>
              <p className="mt-1 text-sm text-slate-300">{s.body}</p>
            </Card>
          </li>
        ))}
      </ol>

        </>
      )}
      {tab === "winning" && (
        <>
      <section className="space-y-3">
        <h2 className="display text-xl font-semibold text-white">Winning</h2>
        <Card className="text-sm text-slate-300">
          <p>
            A player or alliance that controls {Math.round(balance.win.regionShareForEarlyWin * 100)}% of all regions and holds that for {balance.win.holdHours} hours wins immediately. Otherwise the match ends on day{" "}
            {balance.match.lengthDays}, the Last Thaw: the ice stops, and whoever has the most people alive in unfrozen land wins. Plan your migrations south.
          </p>
          <p className="mt-2">
            Or raise the Great Hearth: a wonder only the capital can build, from the Medieval Age with Engineering. It costs the wealth of an empire and takes three days; every rival is told the moment you begin, and taking your capital stops it. Finish it and you win on the spot.
          </p>
          <p className="mt-2">
            Score counts regions held, population and the age you reached, plus bonuses for being first in the match to each age, the first Harbor, Temple and Train, and the first to begin the Great Hearth. The Leaderboard shows who holds each first.
          </p>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="display text-xl font-semibold text-white">Good to know</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
          <li>Soldiers eat three times what a worker eats. A big standing army is the fastest way to burn a food surplus. They still count as people in your score, so a garrison is never wasted points.</li>
          <li>Early soldiers have a job before anyone can touch you: the neutral tribes hold {balance.ai.neutralOre.min} to {balance.ai.neutralOre.max} copper, tin or iron each, guarded by a handful of warriors, and they can be raided from day one. That ore is the Bronze and Iron Ages arriving early.</li>
          <li>New players cannot be attacked for the first {balance.match.protectionDays} days (scaled by match speed). Attacking someone ends your own protection.</li>
          <li>Storehouses and Granaries hide part of your stock from raiders; the rest can be moved out with a Send resources mission before a raid lands.</li>
          <li>Metals come from a Mine on a region that has copper, tin or iron, and horses from Stables on a region with horses. Otherwise trade or raid for them.</li>
          <li>The seven ages are {AGES.join(", ")}. Each unlocks about five buildings and three units. Boats arrive with Shipbuilding in the Classical Age: build a Harbor on a coast for Galleys, then Cogs, Ironclads and Destroyers by age. Ships sail one sea lane at a time, patrol it, and fight any enemy ship that tries to cross; a crossing with no escort is turned back by a patrol.</li>
          <li>AI tribes fill empty slots. Easy ones hoard and sleep; hard ones react to your attacks, flee the ice and hunt weak neighbours.</li>
          <li>
            <b>House rules.</b> One account per person, and play by hand. Scripts, bots and browser agents that play for you are not allowed: the game logs every command and flags accounts whose play has a machine's rhythm, and those accounts are suspended.
          </li>
          <li>Tournaments are the scheduled weekly matches at 1x and the only ranked ones: they count toward the Hall of Fame and its titles (Survivor, Conqueror, Builder, Explorer). Register any time; you are enrolled when it starts whether or not you come to the lobby, which opens an hour before so you can pick your capital. Skip it and a starting region is picked for you; and if you were registered but are somehow not in, Join still works during the first three days. Anyone with a verified email can create a public or private game at up to {balance.match.maxGameSpeed}x, which is the whole match in about four hours, one game at a time; private games need an invite code to join. The creator may end a game early at any time: it finishes with no winner, and its report stays at its address saying so.</li>
          <li>When day 30 ends the map falls into the winter night for two hours: the ice has stopped, the winner is named, and the final report is one click away.</li>
        </ul>
      </section>

        </>
      )}
      {tab === "advanced" && <AdvancedSection open />}
      {tab === "techs" && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex overflow-hidden rounded-md border border-slate-700 text-sm">
              {(["graph", "list"] as const).map((v) => (
                <button key={v} onClick={() => setTechView(v)} className={`px-3 py-1.5 capitalize ${techView === v ? "bg-sky-500/20 text-sky-100" : "text-slate-400 hover:text-slate-200"}`}>
                  {v}
                </button>
              ))}
            </span>
            <p className="text-sm text-slate-400">The graph shows what leads to what; the list shows every number. Both carry every tech.</p>
          </div>
          {techView === "graph" ? <TechTreeGraph height="none" /> : <TechTree />}
        </>
      )}
      {tab === "buildings" && <BuildingList />}
      {tab === "units" && <UnitList />}

      <div className="glass glass-strong flex flex-wrap items-center justify-between gap-3 rounded-xl p-5">
        <p className="text-slate-200">That is everything you need for day one. The rest you learn with the ice at your back.</p>
        <div className="flex gap-2">
          <Link to="/register" className="btn-ember display rounded-md px-4 py-2 text-sm font-semibold">
            Play free
          </Link>
          <Link to="/matches" className="btn-ice rounded-md px-4 py-2 text-sm">
            Find a match
          </Link>
        </div>
      </div>
    </main>
  );
}

/** Collapsed by default: the numbers behind the rules for players who want to optimise. */
function AdvancedSection({ open: initial = false }: { open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="space-y-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-xl border border-slate-700/50 bg-slate-950/40 px-4 py-3 text-left hover:border-sky-400/40"
        aria-expanded={open}
      >
        <span>
          <span className="block text-xs font-medium uppercase tracking-[0.25em] text-sky-300">For the optimisers</span>
          <span className="display text-xl font-semibold text-white">Advanced: the numbers behind the rules</span>
        </span>
        <span className="text-slate-400">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="space-y-4">
          <p className="text-sm text-slate-400">All rates are per game hour. In a faster match everything below happens proportionally faster in real time.</p>
          {ADVANCED.map((a) => (
            <Card key={a.title}>
              <h3 className="display mb-2 font-semibold text-white">{a.title}</h3>
              <div className="text-sm leading-relaxed text-slate-300">{a.body}</div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
