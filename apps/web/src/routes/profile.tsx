import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMe } from "../api/auth.js";
import { Card, fmt } from "../components/ui.js";

interface History {
  history: Array<{ matchId: string; name: string; speed: number; finishedAt: string | null; rank: number; score: number; regions: number; age: string; won: boolean }>;
  active: Array<{ matchId: string; name: string; status: string }>;
  wins: number;
  played: number;
}

export function ProfilePage() {
  const me = useMe();
  const q = useQuery({ queryKey: ["me", "history"], queryFn: () => fetch("/api/me/history", { credentials: "include" }).then((r) => r.json() as Promise<History>), enabled: !!me.data });
  if (!me.data) return <p className="p-6 text-slate-400">Log in to see your profile.</p>;
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-semibold">{me.data.displayName}</h1>
      <p className="text-sm text-slate-400">
        {me.data.email} · {q.data ? `${q.data.played} matches played, ${q.data.wins} won` : ""}
      </p>
      {q.data?.active.length ? (
        <Card>
          <h2 className="mb-2 text-sm font-medium">Current matches</h2>
          <ul className="space-y-1 text-sm">
            {q.data.active.map((a) => (
              <li key={a.matchId}>
                <Link to="/match/$matchId" params={{ matchId: a.matchId }} className="text-sky-400 hover:underline">
                  {a.name}
                </Link>{" "}
                <span className="text-slate-500">{a.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card>
        <h2 className="mb-2 text-sm font-medium">Past matches</h2>
        {q.data?.history.length === 0 && <p className="text-sm text-slate-400">No finished matches yet.</p>}
        <ul className="divide-y divide-slate-800 text-sm">
          {q.data?.history.map((h) => (
            <li key={h.matchId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {h.won && <span className="mr-1">🏆</span>}
                {h.name} <span className="text-slate-500">{h.finishedAt ? new Date(h.finishedAt).toLocaleDateString() : ""}</span>
              </span>
              <span className="text-slate-300">
                #{h.rank} · {h.regions} regions · {h.age} · {fmt(h.score)} pts
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
