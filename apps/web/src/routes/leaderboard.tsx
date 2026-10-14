import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Card, fmt } from "../components/ui.js";

interface Row {
  rank: number;
  id: string;
  name: string;
  isAi: boolean;
  allianceTag: string | null;
  ageName: string;
  score: number;
  regions: number;
  population: number;
  eliminated: boolean;
}
interface Board {
  match: { id: string; name: string; status: string; speed: number; day: number; iceLatitude: number; totalRegions: number; winnerPlayerId: string | null };
  players: Row[];
}

export function LeaderboardPage() {
  const { matchId } = useParams({ from: "/match/$matchId/leaderboard" });
  const q = useQuery({
    queryKey: ["leaderboard", matchId],
    queryFn: () => fetch(`/api/matches/${matchId}/leaderboard`, { credentials: "include" }).then((r) => r.json() as Promise<Board>),
    refetchInterval: 30_000,
  });
  if (!q.data?.players) return <p className="p-6 text-slate-400">Loading leaderboard...</p>;
  const { match, players } = q.data;
  const winner = players.find((p) => p.id === match.winnerPlayerId);
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{match.name}</h1>
          <p className="text-sm text-slate-400">
            Day {match.day.toFixed(1)} of 30 · ice beyond {match.iceLatitude.toFixed(0)}° · {match.totalRegions} regions · {match.speed}x
          </p>
        </div>
        <Link to="/match/$matchId" params={{ matchId }} className="text-sm text-sky-400 hover:underline">
          Back to the map
        </Link>
      </div>
      {match.status === "finished" && (
        <Card className="border-amber-500/40 bg-amber-500/10 text-amber-100">The match is over. {winner ? `${winner.name} won.` : "No winner was recorded."}</Card>
      )}
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Player</th>
              <th className="px-3 py-2">Age</th>
              <th className="px-3 py-2 text-right">Regions</th>
              <th className="px-3 py-2 text-right">People</th>
              <th className="px-3 py-2 text-right">Score</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id} className={`border-t border-slate-800 ${p.eliminated ? "text-slate-600" : ""}`}>
                <td className="px-3 py-1.5 tabular-nums">{p.rank}</td>
                <td className="px-3 py-1.5">
                  {p.allianceTag && <span className="mr-1 rounded bg-slate-800 px-1 text-xs text-slate-300">[{p.allianceTag}]</span>}
                  {p.name}
                  {p.isAi && <span className="ml-1 text-xs text-slate-500">AI {(p as { aiLevel?: string | null }).aiLevel ?? ""}</span>}
                  {p.eliminated && <span className="ml-1 text-xs">eliminated</span>}
                </td>
                <td className="px-3 py-1.5 text-slate-400">{p.ageName}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{p.regions}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(p.population)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(p.score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </main>
  );
}
