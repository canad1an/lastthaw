import { Link } from "@tanstack/react-router";
import { Card } from "../components/ui.js";

export function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">About Last Thaw</h1>
        <p className="mt-2 text-slate-400">A browser strategy game about the last warm month before the ice.</p>
      </header>

      <section className="space-y-3 text-slate-300">
        <p>
          Every match is the same story told differently. Up to a hundred players start as five families of hunter-gatherers scattered across a real map of
          Earth. Over thirty days they gather, build, research and fight their way from the Stone Age toward the Medieval, while an ice age advances from both
          poles on a schedule everyone can see. Land that was safe on day one is gone by week three. By the end, whoever is left is crowded around the equator,
          and only one of them wins.
        </p>
        <p>
          There is no pause button. Build queues, research, armies and the ice all keep moving while you are away, the way they do in OGame or Travian. You
          check in, set your workers, queue the next hour of work, send a raid, and come back to the reports.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Card>
          <h2 className="font-medium text-white">Inspirations</h2>
          <p className="mt-1 text-sm text-slate-400">OGame for timers and auto-resolved battles, Travian for rounds with a winner, Supremacy 1914 for a real-world map with AI filling the gaps.</p>
        </Card>
        <Card>
          <h2 className="font-medium text-white">Matches</h2>
          <p className="mt-1 text-sm text-slate-400">A new match opens every week and lasts exactly thirty days, so several run at once. You join before the start; nobody joins mid-match.</p>
        </Card>
        <Card>
          <h2 className="font-medium text-white">Fair play</h2>
          <p className="mt-1 text-sm text-slate-400">One account per person. Accounts that share a network or device, or feed each other resources, are flagged for a human to review. Nothing is banned automatically.</p>
        </Card>
        <Card>
          <h2 className="font-medium text-white">Free</h2>
          <p className="mt-1 text-sm text-slate-400">Last Thaw is free. If paid features ever exist they will never affect combat or the economy.</p>
        </Card>
      </section>

      <section className="space-y-2 text-slate-300">
        <h2 className="text-xl font-semibold text-white">The map</h2>
        <p>
          The world is divided into 408 regions of roughly equal value, generated from real borders. Big countries simply contain more regions. Each region has
          a terrain type and one or two special resources such as copper, tin, iron, horses or fertile soil. No region has everything, which is the point: you
          will need to trade, ally or take what you lack.
        </p>
      </section>

      <p className="text-sm text-slate-400">
        Ready?{" "}
        <Link to="/how-to-play" className="text-sky-400 hover:underline">
          Read how to play
        </Link>{" "}
        or{" "}
        <Link to="/matches" className="text-sky-400 hover:underline">
          find a match
        </Link>
        .
      </p>
    </main>
  );
}
