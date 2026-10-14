import { useQuery } from "@tanstack/react-query";
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
  champions: Array<{ name: string; wins: number; played: number; best: number }>;
}

export function HallOfFamePage() {
  const q = useQuery({ queryKey: ["public", "hall-of-fame"], queryFn: () => fetch("/api/public/hall-of-fame").then((r) => r.json() as Promise<Fame>) });
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Hall of fame</h1>
        <p className="mt-2 text-slate-400">Every finished match and who outlasted the ice.</p>
      </header>

      <section>
        <h2 className="mb-2 text-xl font-semibold text-white">Champions</h2>
        {q.data?.champions.length === 0 && <Card>No finished matches yet.</Card>}
        {q.data && q.data.champions.length > 0 && (
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2 text-right">Wins</th>
                  <th className="px-3 py-2 text-right">Played</th>
                  <th className="px-3 py-2 text-right">Best finish</th>
                </tr>
              </thead>
              <tbody>
                {q.data.champions.map((c) => (
                  <tr key={c.name} className="border-t border-slate-800">
                    <td className="px-3 py-1.5">{c.name}</td>
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
        <h2 className="mb-2 text-xl font-semibold text-white">Past matches</h2>
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
                  {m.winner.isAi && <span className="ml-1 text-xs text-slate-500">AI</span>} · {m.winner.regions} regions · {m.winner.age} Age · {fmt(m.winner.score)} pts
                </p>
              ) : (
                <p className="text-sm text-slate-400">No winner recorded.</p>
              )}
              <ol className="text-xs text-slate-400">
                {m.top.map((t, i) => (
                  <li key={t.name}>
                    {i + 1}. {t.name}
                    {t.isAi ? " (AI)" : ""} · {fmt(t.score)} pts
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
