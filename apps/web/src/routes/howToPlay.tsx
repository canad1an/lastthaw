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
    title: "Advisors: what they cost and what they do",
    body: (
      <>
        <p>
          The Economic advisor is paid every game hour, for every region you hold: {balance.advisors.economic.perRegionPerHour.food} food, {balance.advisors.economic.perRegionPerHour.wood} wood and {balance.advisors.economic.perRegionPerHour.stone} stone per region, plus {balance.advisors.economic.perRegionPerHour.copper} copper and {balance.advisors.economic.perRegionPerHour.iron} iron per region (each rounded up), drawn from your capital first and then your other regions. The Advisors tab works every wage out for five and forty regions. Each advisor takes roughly a fifth of what a region gathers in wood and stone and a tenth of its food, so two advisors are a real cost and all of them together stall an empire. Hiring is a day's contract paid up front; fire when you like, nothing is refunded, and a day passes before you can rehire.
        </p>
        <p>
          Max, the Military advisor, is paid {balance.advisors.military.perRegionPerHour.food} food, {balance.advisors.military.perRegionPerHour.wood} wood, {balance.advisors.military.perRegionPerHour.stone} stone, {balance.advisors.military.perRegionPerHour.copper} copper and {balance.advisors.military.perRegionPerHour.iron} iron per region per game hour. Each pass he trains at most {balance.advisors.military.trainPerPass} orders and queues at most {balance.advisors.military.fortifyPerPass} walls, every border region toward its garrison (your number, doubled when passive, doubled again for the capital), reinforces the exposed from the interior's surplus, and runs up to three campaigns: a sighting younger than {balance.advisors.military.sightingMaxHours} hours or a watchtower view, a force {balance.advisors.military.forceMargin} times the defenders' strength mustered at the nearest region with a land route (siege engines when there is a wall), then the conquest; a beaten force musters again {Math.round((balance.advisors.military.retryMargin - 1) * 100)}% larger, and after {balance.advisors.military.maxAttempts} defeats the campaign is abandoned. He never attacks allies, pact partners or tribes under beginner protection. Training he orders is supplied by convoys like builds, and so is yours: an order a region cannot pay waits for materials just as a build does.
        </p>
        <p>
          Freya, the Warden of the Thaw, is paid {balance.advisors.thaw.perRegionPerHour.food} food, {balance.advisors.thaw.perRegionPerHour.wood} wood, {balance.advisors.thaw.perRegionPerHour.stone} stone, {balance.advisors.thaw.perRegionPerHour.copper} copper and {balance.advisors.thaw.perRegionPerHour.iron} iron per region per game hour. Each pass she evacuates at most {balance.advisors.thaw.evacuatePerPass} regions that freeze within your warning (24 hours unless you change it), each to the nearest region of yours that freezes at least {balance.advisors.thaw.safeMarginDays} days later, or the longest-lasting one in reach; moves the capital when it freezes within your capital warning (48 hours unless you change it) and no wagon is already out; and, while any region is on the clock, settles the nearest free region on the warm side that stays unfrozen at least {balance.advisors.thaw.settleMinDays} days from today, one colony on the road at a time. A region is "on the clock" when it freezes within {balance.advisors.thaw.clockPeriods} warnings; those carry a snowflake on the map.
        </p>
        <p>
          Every {balance.advisors.economic.passMinutes} game minutes the Economic advisor makes a pass: the capital first, then your most populous regions; in each, the buildings in its usual order (Huts first when crowded, a Storehouse first when stores are nearly full), raising any below your minimum that can stand there, at most {balance.advisors.economic.maxQueuedPerPass} builds a pass and never more than one waiting build per region. With the other regions' resources allowed, a build the region cannot pay is queued and supplied by convoys like any other (up to {balance.advisors.economic.maxOwed.toLocaleString("en-US")} goods owed per build). If a wage cannot be met, the advisor stops working and you are told; it resumes when the next charge succeeds. Balanced population moves at most {Math.round(balance.advisors.economic.balanceSharePerPass * 100)}% of a region's people per pass, from regions more than {Math.round(balance.advisors.economic.balanceBand * 100)}% above the empire's average fill to the emptiest regions below it, as columns on the road.
        </p>
      </>
    ),
  },
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
          A region above capacity does not empty itself: with an Economic advisor set to overflow it sends {pct(eco.migrationPerHour)} of the overflow per hour to a neighbouring region of yours with room (balanced mode evens out every region instead); without one you move people by hand. Above {mult(ev.plague.crowding)} capacity it may catch
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
        Harbor {balance.win.milestones.harbor}, Temple {balance.win.milestones.temple}, Train {balance.win.milestones.train}, and the first to begin the Great Hearth {balance.win.milestones.wonder}. Taking another tribe's capital is worth {balance.win.milestones.capital}, every time. Below the winner, final rank is by score.
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
  { title: "Build and research", body: "Each region has a build queue with ten slots; research has a ten-deep queue of its own and draws ore and horses from any region you own, so nothing has to be hauled home. A build or training order your region can pay for is paid on the click; one it cannot waits for materials, which convoys bring from your other regions (see the Advisors tab for how hauling works). Huts raise your population capacity, Storehouses hold more, gathering buildings raise output. Fire making, Flint tools and Agriculture lead to Bronze working, which opens the next age." },
  { title: "Hire an advisor", body: "When the empire is too big to run by hand, open the Advisors menu: each advisor is shown with what they do, and Hire shows the wage before you agree. Mara, the Economic advisor, runs buildings, supply, workers and people; Max, the Military advisor, keeps your borders and takes the regions you mark; Freya, the Warden of the Thaw, evacuates regions before they freeze, moves the capital out of the ice's path and settles the warm side. The Advisors tab above explains each in full. Each costs roughly a fifth of a region's wood and stone, so hire for the chore you have, not all of them. Set the minimum level you want for each building and the advisor raises them in every region where they can stand, a few builds a pass, letting convoys bring what a region cannot pay if you allow it. She also sets each region's worker shares between food, wood and stone from what the region and the empire need (full stores get no more, waiting builds get what they owe, nobody starves), unless you switch that off. Choose how people are moved: not at all, overflow from crowded regions to neighbours with room, or balanced so every region holds a similar share of its capacity. The advisor also leaves you suggestions: stores near their cap, regions nearly full, ore with no Mine, haulers idle, builds that have waited too long. The wage is steep and charged every game hour from your capital first, scaling with the regions you hold; miss it and the advisor stops until paid. Hiring buys a day of wages at once and a fired advisor stays away a day. A set-all control puts one minimum on every building at once, each capped at its own maximum, and you adjust single buildings after. Without an Economic advisor nobody moves on their own, so a crowded region stays crowded until you move people. Max works to a stance: passive garrisons and walls your exposed border regions and nothing more; measured also takes the regions you mark from their panel (scouts first unless you say otherwise, then a muster at your nearest region with a land route, then the attack); aggressive also picks weak neighbours himself when the list has room and raids rich ones with spare soldiers. His report names your most exposed regions, and the map shows a red crossed swords on every target and an amber shield on the regions most at risk." },
  { title: "Expand", body: "Train five Settlers and send them on a Settle mission to any empty region next to yours (dashed outlines on the map). They become its first workers. A region over its capacity does not spread out on its own: an Economic advisor (see Hire an advisor) moves the surplus for you, or you move people by hand. To take land someone already holds, send soldiers on a Conquer mission with at least five Settlers; the settlers stay out of the fight and occupy the region if you win. Colonies pay back with haulers: train caravans, upgrade them to Wagons (Bronze) and Trains (Medieval, with Railways on top of Roads) for far more capacity and speed, then set up a trade route under the region's Routes tab (fixed loads or a share of production) and they haul goods to your capital on a schedule. Research Road building, then build Roads once in a region to connect it to every neighbour: legs between two road regions are 40% faster, and roads show on the map. A build you cannot pay for on the spot is supplied for you: what is short is fetched from your capital first, then the nearest regions with stock, by materials routes that size their convoys to the load and retire when it has all arrived. The goods are set aside at the source the moment the route is decided, as a warehouse sets aside a delivery: nothing else can spend them, and the haulers load and leave the moment they arrive. Cancel the build and they go back on the shelf. One convoy serves a build from several regions: it loads where it starts and calls at the nearest other regions holding goods for the same place while it has room, then delivers; a build queued while a convoy is still collecting for that region rides along if there is room, with an extra stop added. Every hauler you own is one pool: a route with none at home calls the nearest spare ones over, idle ones first, so train haulers in any region and they go where the work is. The Logistics menu shows what is on the way and which routes are waiting." },
  { title: "Scout, mark and take notes", body: "Tap a region you know nothing about and, if Scouts are standing in a region of yours, you can send one with a tap. Only Scouts can scout: fast, cheap, trained from the first day. Scouting a held region carries risk: each scout may be caught, with a 5% chance in a quiet village rising by 1% for every ten soldiers standing there, +10% behind a wall, doubled by a Watchtower in or next to the region, and never above 40%; empty land is safe. A caught scout files no report and the region's owner is told whose it was, so send two or three scouts where it matters: the report arrives if any get through. The region panel's scout buttons have a counter for how many to send. The report arrives in your inbox, where any message about a region, a scout report or a battle, has an Open region button; the pop-up for a new message has it too. It centres the map on the region, flashes it so your eye lands on it, and opens its panel, and it is also written into your notes on that region with the day and time, so you always know what you learned and when; things may have changed since. Every battle in a region goes into both sides' notes too: what each brought, what it cost, how it ended. Any region can carry your own notes and a coloured marker: the marker shows as a pin on the map, and nobody else ever sees your notes." },
  { title: "Fight", body: "Train soldiers from your workers. Raids steal unprotected stock; conquests take the region. Travel time depends on distance, terrain and your slowest unit, and the defender hears the moment you set out: a chime, a message naming the region, the rough size and the arrival time, and a red marker on the map with the countdown. A Watchtower (Stone Age, built once) keeps every region next to it in plain view, units and all, and shows the exact make-up of an attacking force once it reaches a region next to the tower's; it also doubles the chance of catching enemy scouts there. Battles resolve themselves on arrival and both sides get a report. Walls, forts, hills and mountains favour the defender." },
  { title: "Hold what you take", body: "Lose your capital and you lose the game: whoever took it inherits every region you held, as freshly conquered land, and banks a large score bonus for the capital; the conqueror gets a pop-up naming every inherited region, each with Open region, and the list stays in the inbox message; a force already marching on land that becomes yours this way stays there when it arrives, soldiers as its garrison and settlers as occupiers, instead of turning for home; if the ice or a rebellion took it, the realm breaks up into neutral tribes. Keep it garrisoned, and move it south ahead of the ice. Conquered land far from your capital drifts toward rebellion. Roads, Temples and Forts raise loyalty; so does keeping enough occupiers there. A region that rebels goes neutral and throws out your people." },
  { title: "Trade and ally", body: "The market lets you offer one resource for another; anyone can accept. Say what you want and how much, and the form suggests a fair offer from each resource your region holds (food, wood and stone are worth about 1 each, horses 15, copper 20, tin 25, iron 30); tap one to fill it in, or set your own price and the form tells you whether it is fair, generous or steep. An offer more than 20x off fair cannot be posted. Alliances share vision, let you reinforce and ship goods to each other, and chat privately. An alliance can win together. The chat chimes and shows a count whenever someone writes, even with the panel closed; mute a player from their message, or the whole chat, and undo it from the chat panel." },
  { title: "Watch the ice", body: "Toggle Ice forecast on the map to see the day each region freezes. Frozen regions stop producing and lose people, so move south before the line reaches you. Most of the map is gone by week four. When the ice is a day from your capital you may make a Last stand: once per match, everything you have in the capital marches south at double speed to a region of yours further from the pole." },
  { title: "Deal with the world", body: "Not everything that happens is someone's doing. Blizzards come with a day's warning and halve production while doubling travel. Plague breaks out in overcrowded regions (Herbal medicine halves the chance; Vaccination or Sanitation stop it). A rich find doubles a mine, quarry or camp for two days, and everyone hears which region it was. Thaw pockets keep a region open three days past its freeze. People fleeing the ice arrive at the nearest empire as a migrant column you can take in for food or turn away. From day 14 the Northern Horde raids out of the ice line; walls and a garrison hold it, empty land does not. Mercenary companies offer themselves for iron and move on after two days." },
  { title: "Talk before you fight", body: "From the Players tab you can propose a non-aggression pact (ending it takes a day's notice), a two-day ceasefire, or demand tribute. A refused tribute gives you a day of cause for war with double loot, and puts a bounty on the refuser's head. Send three or more soldiers on an Expedition to a far region nobody has scouted: they may bring back a free tech, a hoard of iron, a tale that lifts loyalty across your realm, or walk into an ambush." },
  { title: "Read the report", body: "Every finished match keeps a report at its own address, public and shareable: a written account of how it went, who led and when the lead changed hands, the biggest battle, how far the ice reached and who was eliminated; every tribe's thirty days in a line; the match day by day; the final standings and the firsts; and links to the replay, the full leaderboard and the tournaments on either side. Tournament results also feed the hall of fame: wins, losses, ties and points for every champion." },
  { title: "Chase the day's prize", body: "Every day has an objective (most regions, most people, biggest larder, most coastal land, most techs or most battles won) worth 100 score to the best player at the day's end. It sits in the bar above the map with its reward; tap it for yesterday's winner and the open bounties. Bounties appear on regions that rebel, on the Horde's camps and on players who refuse tribute; win a battle against them and the reward is delivered to your capital. The Leaderboard shows today's objective, open bounties and a timeline of everything that has happened in the match." },
];

type Tab = "basics" | "winning" | "advisors" | "advanced" | "techs" | "buildings" | "units";
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "basics", label: "Basics" },
  { id: "winning", label: "Winning and tips" },
  { id: "advisors", label: "Advisors" },
  { id: "advanced", label: "Advanced" },
  { id: "techs", label: "Tech tree" },
  { id: "buildings", label: "Buildings" },
  { id: "units", label: "Units" },
];

const ecoAdv = balance.advisors.economic;
const mil = balance.advisors.military;
const thaw = balance.advisors.thaw;
const wageAt = (per: Record<string, number>, regions: number) =>
  Object.entries(per)
    .map(([k, v]) => `${Math.max(1, Math.ceil(v * regions)).toLocaleString("en-US")} ${k}`)
    .join(", ");

/** The Advisors tab: who they are, what each does, what they cost, and the rules they all share. */
function AdvisorsSection() {
  return (
    <section className="space-y-4">
      <header>
        <p className="mb-1 text-xs font-medium uppercase tracking-[0.25em] text-sky-300">Staff for hire</p>
        <h2 className="display text-xl font-semibold text-white">Advisors: let someone else run the routine</h2>
        <p className="mt-2 text-sm text-slate-300">
          Once an empire is more than a handful of regions, opening each one to queue the same upgrades or shuffle the same people is a chore. The Advisors menu in a match hires staff who do it for you, each for a steep wage every game hour on a day's contract paid up front. Fire them when you like; nothing is refunded and they stay away a day. The wages are set so that each advisor costs roughly a fifth of what a region gathers in wood and stone: two are a real cost, all of them together leave nothing to build with. There are three so far.
        </p>
      </header>

      <Card className="space-y-3">
        <div className="flex items-center gap-3">
          <img src="/advisors/economic.jpg" alt="" className="h-16 w-16 shrink-0 rounded-full" />
          <div>
            <h3 className="display font-semibold text-white">Mara, the Economic advisor</h3>
            <p className="text-xs text-slate-400">Buildings, supply, workers and people.</p>
          </div>
        </div>
        <div className="space-y-2 text-sm leading-relaxed text-slate-300">
          <p>
            <b>Minimum levels.</b> You set the minimum level you want for each building, or one level for every building with Apply to all. Each pass she raises any building below its minimum in every region where it can stand (the right age and tech, the right local resource or coast, the building it needs already there), the capital first and then your most populous regions, in the order the land needs them: Huts first when a region is crowded, a Storehouse first when stores are nearly full. At most {ecoAdv.maxQueuedPerPass} builds a pass, never more than one waiting build per region, and never more than {ecoAdv.maxWaitingBuilds} builds waiting on hauling across the empire; beyond that she only queues what a region can pay for itself.
          </p>
          <p>
            <b>Other regions' resources.</b> With this on, a build the region cannot pay for is queued anyway and supplied by convoys exactly like one you queue yourself (see Hauling below). Off, each region pays for its own.
          </p>
          <p>
            <b>Worker shares.</b> Each pass she sets every region's split between food, wood and stone from what the region and the empire need: a store near its cap gets no more, a resource your waiting builds owe gets more, and no region is left to starve. Switch it off and your own sliders stand.
          </p>
          <p>
            <b>People.</b> Nobody moves on their own any more. Choose Off, Overflow (a region over its capacity sends {Math.round(balance.economy.migrationPerHour * 100)}% of the surplus an hour to neighbouring regions of yours with room, as the game once did for everyone) or Balanced (every region toward the same share of its capacity: columns of people leave the fullest regions for the emptiest, at most {Math.round(ecoAdv.balanceSharePerPass * 100)}% of a region's people a pass). Without her hired, a crowded region stays crowded until you move people by hand.
          </p>
          <p>
            <b>Her report</b> after every pass says what was queued, what was skipped and why (unaffordable, queue full, cannot stand there, hauling busy), and leaves suggestions with an Open region button: stores near their cap with no route out, regions nearly full, ore with no Mine, haulers idle, builds that have waited too long. Regions you tick under "leaves alone" she never touches.
          </p>
          <p>
            <b>Wage:</b> {ecoAdv.perRegionPerHour.food} food, {ecoAdv.perRegionPerHour.wood} wood, {ecoAdv.perRegionPerHour.stone} stone, {ecoAdv.perRegionPerHour.copper} copper and {ecoAdv.perRegionPerHour.iron} iron per region per game hour, each rounded up. Five regions: {wageAt(ecoAdv.perRegionPerHour, 5)}. Forty: {wageAt(ecoAdv.perRegionPerHour, 40)}.
          </p>
        </div>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center gap-3">
          <img src="/advisors/military.jpg" alt="" className="h-16 w-16 shrink-0 rounded-full" />
          <div>
            <h3 className="display font-semibold text-white">Max, the Military advisor</h3>
            <p className="text-xs text-slate-400">Borders, garrisons, walls and conquest.</p>
          </div>
        </div>
        <div className="space-y-2 text-sm leading-relaxed text-slate-300">
          <p>
            <b>The front.</b> Every pass he lists which of your regions border a rival or a neutral tribe, what faces each one (live from a watchtower, from a scout report, or a guess when nobody has looked), and an exposure score: what faces the region divided by what holds it, walls counted. The five most exposed are in his report with a line each, carry an amber shield on the map, and show their exposure on the region panel.
          </p>
          <p>
            <b>Defence, every stance.</b> You set a garrison, the soldiers wanted in every border region (passive doubles it, the capital doubles it again). He trains the best land soldier of your age toward it, at most {mil.trainPerPass} orders a pass, moves surplus soldiers in from interior regions, and with Fortify on queues a Palisade, then Walls, then a Watchtower where a region is exposed, at most {mil.fortifyPerPass} a pass.
          </p>
          <p>
            <b>Stances.</b> <i>Passive</i>: defence only, even marked targets wait. <i>Measured</i>: defence plus campaigns against the regions you mark, in order. <i>Aggressive</i>: measured, and when your list has room he picks weak neighbours himself; with Raids on he also raids the weakest rich neighbour from a border region with soldiers to spare, one raid a pass.
          </p>
          <p>
            <b>Targets and campaigns.</b> Open any region that is not yours and press ⚔ Target for the Military advisor; it joins his ordered list and gets a red crossed swords on the map. He runs up to three campaigns at once (your choice, one to three). Each one goes: <i>intel</i>, where he sends two Scouts unless you turn Scout first off or a watchtower already sees the region (a sighting older than {mil.sightingMaxHours} game hours is not good enough); <i>muster</i>, at your nearest region with a land route, where he orders a force {mil.forceMargin} times the defenders' strength in your best soldier, siege engines if there is a wall, and the settlers a conquest needs; and <i>marching</i>, the attack itself. Empty land is settled rather than fought for. A beaten force musters again {Math.round((mil.retryMargin - 1) * 100)}% larger; after {mil.maxAttempts} defeats he gives up on that target and tells you. He never attacks allies, pact partners or tribes under beginner protection, and waits when a target is protected or under a pact.
          </p>
          <p>
            <b>Working with Mara.</b> Training he orders is supplied by convoys like any build, and her worker shares already favour what waiting orders owe. When a muster region is short of free workers and Mara is hired with people moves on, she brings a column; otherwise his report asks you to move people or hire her.
          </p>
          <p>
            <b>Wage:</b> {mil.perRegionPerHour.food} food, {mil.perRegionPerHour.wood} wood, {mil.perRegionPerHour.stone} stone, {mil.perRegionPerHour.copper} copper and {mil.perRegionPerHour.iron} iron per region per game hour, each rounded up: iron-heavy, because armies are. Five regions: {wageAt(mil.perRegionPerHour, 5)}. Forty: {wageAt(mil.perRegionPerHour, 40)}.
          </p>
        </div>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center gap-3">
          <img src="/advisors/thaw.jpg" alt="" className="h-16 w-16 shrink-0 rounded-full" />
          <div>
            <h3 className="display font-semibold text-white">Freya, the Warden of the Thaw</h3>
            <p className="text-xs text-slate-400">Evacuations, the capital and the warm side.</p>
          </div>
        </div>
        <div className="space-y-2 text-sm leading-relaxed text-slate-300">
          <p>
            <b>The clock.</b> Every pass she reads the ice schedule against every region you hold: the day the ice line reaches a region's centre is fixed by its latitude (a thaw pocket spares it a while longer). Regions freezing within {thaw.clockPeriods} warnings are on the clock, soonest first, with a line each (people, units and goods still there) and an Open region button, a snowflake on the map, and an alert on the Advisors menu once one is inside the warning.
          </p>
          <p>
            <b>Evacuation.</b> A region that freezes within your warning ({"24"} hours unless you change it) is evacuated exactly as if you had pressed Evacuate: everyone and every unit leaves as one column carrying what it can, the stores follow by hauler, and the region stays yours but empty. The destination is the nearest region of yours with a route that freezes at least {thaw.safeMarginDays} days later; if none outlasts it, the longest-lasting one in reach; or your capital, if you choose that and it is safe itself. At most {thaw.evacuatePerPass} regions a pass. A region with no safe ground in reach is reported, not emptied: move the people by hand, by sea if you have ships.
          </p>
          <p>
            <b>The capital.</b> The capital wagon is slow, so it leaves earlier: when the capital freezes within your capital warning ({"48"} hours unless you change it), the wagon sets out for your longest-lasting populous region with a route, carrying what it can of the stores, and you get a message. The capital changes when it arrives. If the ice beats the wagon, the game moves the capital for you, but everything still in the old one is lost.
          </p>
          <p>
            <b>The warm side.</b> While any region is on the clock, she keeps one colony on the road: five settlers from the safe region holding the most (trained there, supplied by convoy, when short) to the nearest free region bordering your safe ground that stays unfrozen at least {thaw.settleMinDays} days from today, preferring land that never freezes. Land that is held is left to you, or to the Military advisor.
          </p>
          <p>
            <b>Wage:</b> {thaw.perRegionPerHour.food} food, {thaw.perRegionPerHour.wood} wood, {thaw.perRegionPerHour.stone} stone, {thaw.perRegionPerHour.copper} copper and {thaw.perRegionPerHour.iron} iron per region per game hour, each rounded up. Five regions: {wageAt(thaw.perRegionPerHour, 5)}. Forty: {wageAt(thaw.perRegionPerHour, 40)}.
          </p>
        </div>
      </Card>

      <Card className="space-y-2">
        <h3 className="display font-semibold text-white">Rules they share</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-300">
          <li>Hiring is a {balance.advisors.contractHours}-hour contract: the first {balance.advisors.contractHours} game hours of wages are taken at once, from your capital first and then your other regions. After that the match charges every whole game hour. The wage grows with the regions you hold.</li>
          <li>If any one resource of the wage cannot be found, the advisor stops working and you get one message; work resumes the next time a charge succeeds. Nobody leaves on their own; only Fire ends a contract. Nothing is refunded, and a fired advisor will not take you back for {balance.advisors.rehireCooldownHours} game hours. Hiring, running a pass and firing at once therefore costs a full day's wage, every time.</li>
          <li>Passes run every {ecoAdv.passMinutes} game minutes while the advisor is paid. Run a pass now forces one, once every {balance.advisors.runEveryMinutes} game minutes; the regular passes carry on regardless.</li>
          <li>Advisors never spend on research, the market or diplomacy, and never touch regions you tick under "leaves alone".</li>
          <li>Everything they do is a normal order: builds, training, routes and armies they create look and behave exactly as if you had placed them, and you can cancel or recall any of it.</li>
        </ul>
      </Card>

      <Card className="space-y-2">
        <h3 className="display font-semibold text-white">Hauling: how builds and training get their materials</h3>
        <div className="space-y-2 text-sm leading-relaxed text-slate-300">
          <p>
            A build or a training order a region cannot pay for on the spot waits for materials. What is short is set aside at the capital first and then at the regions holding the most of it (small offers last), as a warehouse sets aside a delivery: nothing else can spend it. One convoy loads where it starts and calls at the nearest other regions holding goods for the same place while it has room, then delivers; a new order for that region rides along on a convoy still collecting if there is room. Every hauler you own is one pool: a route with none at home calls the nearest spare ones over, idle ones first, so train haulers anywhere. Cancel the order and the goods go back on the shelf.
          </p>
          <p>
            Two limits keep the roads sane: at most {balance.trade.maxSupplyConvoys} materials convoys and {balance.trade.maxReliefMoves} relief moves of haulers per player on the road at once; the rest wait their turn. The Logistics menu shows the convoys, what is aboard, where they call, and which routes are waiting.
          </p>
        </div>
      </Card>
    </section>
  );
}

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
          <li>Tournaments are the scheduled weekly matches at 1x and the only ranked ones: they count toward the Hall of Fame and its titles (Survivor, Conqueror, Builder, Explorer). Register any time; you are enrolled when it starts whether or not you come to the lobby, which opens an hour before so you can pick your capital. Skip it and a starting region is picked for you; and if you were registered but are somehow not in, Join still works during the first three days. Anyone with a verified email can create a public or private game at up to {balance.match.maxGameSpeed}x, which is the whole match in about four hours, one game at a time; private games need an invite code to join. The creator also picks the game's resource rate (1x to 5x): everything gathered or mined, food included, comes in at that rate, separately from the speed, so a 1x game at 2x resources is still a real month with twice the goods. Tournaments are always 1x. The creator may end a game early at any time: it finishes with no winner, and its report stays at its address saying so.</li>
          <li>When day 30 ends the map falls into the winter night for two hours: the ice has stopped, the winner is named, and the final report is one click away.</li>
        </ul>
      </section>

        </>
      )}
      {tab === "advisors" && <AdvisorsSection />}
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
