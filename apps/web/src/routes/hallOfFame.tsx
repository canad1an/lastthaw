import { useQuery } from "@tanstack/react-query";
import { usePageMeta } from "../seo.js";
import { Card, fmt } from "../components/ui.js";

interface Fame {
  matches: Array<{
    id: string;
    name: string;
    speed: number;
    startedAt: string;
    finishedAt: string | null;
    winner: { name: string; isAi: boolean; age: string; score: number; regions: number } | null;
    top: Array<{ name: string; score: number; isAi: boolean; age: string }>;
  }>;
  champions: Array<{ name: string; wins: number; played: number; best: number; score: number; titles: Array<{ title: string; n: number }> }>;
}

export function HallOfFamePage() {
  usePageMeta({ title: "Hall of fame", description: "Every finished Last Thaw match with its winner, and the champions ranked by tournament wins and titles: Survivor, Conqueror, Builder, Explorer.", path: "/hall-of-fame" });
  const q = useQuery({ queryKey: ["public", "hall-of-fame"], queryFn: () => fetch("/api/public/hall-of-fame").then((r) => r.json() as Promise<Fame>) });
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
      <header>
        <p className="mb-3 shadow-copy text-xs font-medium uppercase tracking-[0.25em] text-sky-300">The survivors</p>
        <h1 className="display text-4xl font-bold sm:text-5xl">
          <span className="frost-text">Hall of fame</span>
        </h1>
        <p className="shadow-copy mt-3 text-lg text-slate-200">Every finished match and who outlasted the ice.</p>
      </header>

      <section>
        <h2 className="display mb-2 text-xl font-semibold text-white">Champions</h2>
        {q.data?.champions.length === 0 && <Card>No finished matches yet.</Card>}
        {q.data && q.data.champions.length > 0 && (
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2">Titles</th>
                  <th className="px-3 py-2 text-right">Wins</th>
                  <th className="px-3 py-2 text-right">Played</th>
                  <th className="px-3 py-2 text-right">Best finish</th>
                </tr>
              </thead>
              <tbody>
                {q.data.champions.map((c) => (
                  <tr key={c.name} className="border-t border-slate-800">
                    <td className="px-3 py-1.5">{c.name}</td>
                    <td className="px-3 py-1.5">
                      {c.titles.map((t) => (
                        <span key={t.title} className="mr-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-200" title={`${t.n}x`}>
                          {t.title}
                          {t.n > 1 ? ` ×${t.n}` : ""}
                        </span>
                      ))}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{c.wins}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{c.played}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">#{c.best}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section>
        <h2 className="display mb-2 text-xl font-semibold text-white">Past matches</h2>
        <div className="space-y-3">
          {q.data?.matches.map((m) => (
            <Card key={m.id} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{m.name}</h3>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">{m.speed}x</span>
                <span className="text-xs text-slate-500">{m.finishedAt ? new Date(m.finishedAt).toLocaleDateString() : ""}</span>
              </div>
              {m.winner ? (
                <p className="text-sm text-slate-200">
                  🏆 {m.winner.name}
                  {" "}· {m.winner.regions} regions · {m.winner.age} Age · {fmt(m.winner.score)} pts
                </p>
              ) : (
                <p className="text-sm text-slate-400">No winner recorded.</p>
              )}
              <ol className="text-xs text-slate-400">
                {m.top.map((t, i) => (
                  <li key={t.name}>
                    {i + 1}. {t.name} · {fmt(t.score)} pts
                  </li>
                ))}
              </ol>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}
