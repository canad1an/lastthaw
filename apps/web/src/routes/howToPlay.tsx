import { Link } from "@tanstack/react-router";
import { AGES, balance } from "@lastthaw/shared";
import { Card } from "../components/ui.js";

const steps: Array<{ title: string; body: string }> = [
  { title: "Join a match and pick a capital", body: "In the lobby you are offered a handful of starting regions, spread far from other players. Pick one, or let the game pick when the match starts. You begin with five families and a small store of food, wood and stone." },
  { title: "Set your workers", body: "Drag the three sliders to split your workers between food, wood and stone. Food feeds everyone and grows the population; wood and stone build everything else. The sliders always add up to 100%. Hover anything to see exactly what it will change." },
  { title: "Build and research", body: "Each region has a build queue with ten slots; research has a ten-deep queue of its own and draws ore and horses from any region you own, so nothing has to be hauled home. Resources are paid when you click. Huts raise your population capacity, Storehouses hold more, gathering buildings raise output. Fire making, Flint tools and Agriculture lead to Bronze working, which opens the next age." },
  { title: "Expand", body: "Train five Settlers and send them on a Settle mission to any empty region next to yours (dashed outlines on the map). They become its first workers. To take land someone already holds, send soldiers on a Conquer mission with at least five Settlers; the settlers stay out of the fight and occupy the region if you win. Colonies pay back with haulers: train caravans, upgrade them to Wagons (Bronze) and Trains (Medieval, with Railways on top of Roads) for far more capacity and speed, then set up a trade route under the region's Routes tab (fixed loads or a share of production) and they haul goods to your capital on a schedule. Research Road building, then build Roads once in a region to connect it to every neighbour: legs between two road regions are 40% faster, and roads show on the map." },
  { title: "Fight", body: "Train soldiers from your workers. Raids steal unprotected stock; conquests take the region. Travel time depends on distance, terrain and your slowest unit, and the defender sees you coming with a countdown. Battles resolve themselves on arrival and both sides get a report. Walls, forts, hills and mountains favour the defender." },
  { title: "Hold what you take", body: "Lose your capital and you lose the game: your realm breaks up into neutral tribes. Keep it garrisoned, and move it south ahead of the ice. Conquered land far from your capital drifts toward rebellion. Roads, Temples and Forts raise loyalty; so does keeping enough occupiers there. A region that rebels goes neutral and throws out your people." },
  { title: "Trade and ally", body: "The market lets you offer one resource for another; anyone can accept. Alliances share vision, let you reinforce and ship goods to each other, and chat privately. An alliance can win together." },
  { title: "Watch the ice", body: "Toggle Ice forecast on the map to see the day each region freezes. Frozen regions stop producing and lose people, so move south before the line reaches you. Most of the map is gone by week four." },
];

export function HowToPlayPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">How to play</h1>
        <p className="mt-2 text-slate-400">Ten minutes to learn, thirty days to win.</p>
      </header>

      <ol className="space-y-4">
        {steps.map((s, i) => (
          <li key={s.title}>
            <Card>
              <h2 className="font-medium text-white">
                <span className="mr-2 text-sky-400">{i + 1}.</span>
                {s.title}
              </h2>
              <p className="mt-1 text-sm text-slate-300">{s.body}</p>
            </Card>
          </li>
        ))}
      </ol>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-white">Winning</h2>
        <Card className="text-sm text-slate-300">
          <p>
            A player or alliance that controls {Math.round(balance.win.regionShareForEarlyWin * 100)}% of all regions and holds that for {balance.win.holdHours} hours wins immediately. Otherwise the match ends on day{" "}
            {balance.match.lengthDays} and the highest score wins. Score counts regions held, population and the age you reached.
          </p>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-white">Good to know</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
          <li>Soldiers eat three times what a worker eats. A big standing army is the fastest way to burn a food surplus.</li>
          <li>New players cannot be attacked for the first {balance.match.protectionDays} days (scaled by match speed). Attacking someone ends your own protection.</li>
          <li>Storehouses and Granaries hide part of your stock from raiders; the rest can be moved out with a Send resources mission before a raid lands.</li>
          <li>Metals come from a Mine on a region that has copper, tin or iron, and horses from Stables on a region with horses. Otherwise trade or raid for them.</li>
          <li>The seven ages are {AGES.join(", ")}. Each unlocks about five buildings and three units. Boats arrive with Shipbuilding in the Classical Age: build a Harbor on a coast for Galleys, then Cogs, Ironclads and Destroyers by age. Ships sail one sea lane at a time, patrol it, and fight any enemy ship that tries to cross; a crossing with no escort is turned back by a patrol.</li>
          <li>AI tribes fill empty slots. Easy ones hoard and sleep; hard ones react to your attacks, flee the ice and hunt weak neighbours.</li>
          <li>Test matches run at 10x: a whole match in three days, every timer ten times faster.</li>
        </ul>
      </section>

      <p className="text-sm text-slate-400">
        <Link to="/matches" className="text-sky-400 hover:underline">
          Find a match
        </Link>
      </p>
    </main>
  );
}
