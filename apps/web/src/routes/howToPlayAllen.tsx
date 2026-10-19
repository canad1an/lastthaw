import { Link } from "@tanstack/react-router";
import { usePageMeta } from "../seo.js";
import { Card } from "../components/ui.js";

/** A joke page for Allen. Linked from nowhere, in the sitemap nowhere, and gone again soon. */
export function HowToPlayAllenPage() {
  usePageMeta({ title: "How to play (Allen's edition)", description: "The short version.", path: "/how-to-play-allen", noindex: true });
  const steps = [
    ["1. Log in.", "You have done this part. Well done. Many never get this far."],
    ["2. Look at the map.", "The blue bits are water. The white bits are ice. The ice is coming for you. It is not personal."],
    ["3. Build things.", "Click a region. Click a building. Wait. That is the whole game, really. The rest is decoration."],
    ["4. Make warriors.", "Then send them at the neighbour who looks the weakest. The neighbour is doing the same maths about you."],
    ["5. Go to bed.", "The game keeps going while you sleep. Your workers do not. Nobody has explained this to them."],
    ["6. Wake up to a message.", "It will say someone raided you. Press Open region. Look at the empty food store. Press it again. Still empty."],
    ["7. Move south.", "Everyone is moving south. The equator gets quite crowded by week three. Bring a coat anyway."],
    ["8. Win.", "Or do not. The ice stops either way, and there is a report page that says how it went. We have found that reading it helps."],
  ];
  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-10">
      <header>
        <p className="mb-3 shadow-copy text-xs font-medium uppercase tracking-[0.25em] text-sky-300">Allen's edition</p>
        <h1 className="display text-4xl font-bold sm:text-5xl">
          <span className="frost-text">How to play</span>
        </h1>
        <p className="shadow-copy mt-3 text-lg text-slate-200">The short version, because the long one has words in it.</p>
      </header>
      <section className="space-y-3">
        {steps.map(([title, body]) => (
          <Card key={title}>
            <p className="font-semibold text-white">{title}</p>
            <p className="mt-1 text-slate-300">{body}</p>
          </Card>
        ))}
      </section>
      <p className="text-sm text-slate-500">
        If any of this was unclear, the{" "}
        <Link to="/how-to-play" className="text-sky-400 hover:underline">
          real manual
        </Link>{" "}
        is right over there, and it has pictures of none of this.
      </p>
    </main>
  );
}
