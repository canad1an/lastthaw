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
  match: { id: string; name: string; status: string; speed: number; day: number; iceLatitude: number; totalRegions: number; winnerPlayerId: string | null; survival: boolean; wonderName: string };
  players: Row[];
  milestones: { key: string; label: string; playerId: string; playerName: string; points: number; at: string }[];
  wonders: { playerId: string | null; playerName: string; regionId: string | null; regionName: string; endsAt: string; waiting: boolean }[];
}

/** Live standings table, used by the top menu dropdown and the full page. */
export function LeaderboardTable({ matchId, compact = false }: { matchId: string; compact?: boolean }) {
  const q = useQuery({
    queryKey: ["leaderboard", matchId],
    queryFn: () => fetch(`/api/matches/${matchId}/leaderboard`, { credentials: "include" }).then((r) => r.json() as Promise<Board>),
    refetchInterval: 30_000,
  });
  if (!q.data?.players) return <p className="p-3 text-sm text-slate-400">Loading leaderboard...</p>;
  const { match, players, milestones = [], wonders = [] } = q.data;
  const winner = players.find((p) => p.id === match.winnerPlayerId);
  return (
    <div className={compact ? "" : "space-y-4"}>
      {!compact && (
        <p className="text-sm text-slate-400">
          Day {match.day.toFixed(1)} of 30 · ice beyond {match.iceLatitude.toFixed(0)}° · {match.totalRegions} regions · {match.speed}x
        </p>
      )}
      {match.status !== "finished" && wonders.length > 0 && (
        <div className="m-3 rounded border border-rose-500/50 bg-rose-950/40 p-2 text-sm text-rose-100">
          {wonders.map((w) => (
            <p key={`${w.playerId}-${w.regionId}`}>
              🔥 <b>{w.playerName}</b> is building the {match.wonderName} in <b>{w.regionName}</b>
              {w.waiting ? " and is still gathering the materials." : <> and finishes it <WonderClock endsAt={w.endsAt} />. Take the region to stop it.</>}
            </p>
          ))}
        </div>
      )}
      <div className="m-3 rounded border border-slate-800 bg-slate-900/60 p-2 text-xs text-slate-300">
        <p className="mb-1 font-semibold text-slate-200">Ways to win</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>Hold 60% of all regions for 48 hours.</li>
          <li>Finish the {match.wonderName} in your capital.</li>
          {match.survival ? <li>Day 30, the Last Thaw: the most people alive in unfrozen land wins. Score ranks the rest.</li> : <li>Highest score on day 30.</li>}
        </ul>
        {milestones.length > 0 && (
          <>
            <p className="mb-1 mt-2 font-semibold text-slate-200">Firsts</p>
            <ul className="space-y-0.5">
              {milestones.map((ms) => (
                <li key={ms.key} className="flex justify-between gap-2">
                  <span>{ms.label}</span>
                  <span className="text-slate-400">
                    {ms.playerName} <span className="text-emerald-300">+{ms.points}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {match.status === "finished" && (
        <div className="m-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-100">The match is over. {winner ? `${winner.name} won.` : "No winner was recorded."}</div>
      )}
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
    </div>
  );
}

function WonderClock({ endsAt }: { endsAt: string }) {
  const secs = Math.max(0, (Date.parse(endsAt) - Date.now()) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return <span>in {h > 0 ? `${h}h ${m}m` : `${m}m`}</span>;
}

export function LeaderboardPage() {
  const { matchId } = useParams({ from: "/match/$matchId/leaderboard" });
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-semibold">Leaderboard</h1>
        <Link to="/match/$matchId" params={{ matchId }} className="text-sm text-sky-400 hover:underline">
          Back to the map
        </Link>
      </div>
      <Card className="overflow-x-auto p-0">
        <LeaderboardTable matchId={matchId} />
      </Card>
    </main>
  );
}
