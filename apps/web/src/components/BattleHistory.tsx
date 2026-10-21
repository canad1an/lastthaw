import { useQuery } from "@tanstack/react-query";
import { regionById, type LiveBattleView, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";

/**
 * Every battle of the match, the ones being fought first, each a tap from its replay. A battle is never forgotten:
 * the record stays for the whole match, and Watch plays the fight again from the first march.
 */
export function BattleHistory({ matchId, state, onOpenBattle, onSelectRegion }: { matchId: string; state: MatchStateView; onOpenBattle: (battleId: string) => void; onSelectRegion: (regionId: string) => void }) {
  const q = useQuery({ queryKey: keys.battleHistory(matchId), queryFn: () => api.battles(matchId, true), refetchInterval: 30_000 });
  const rows = q.data ?? [];
  const me = state.me.playerId;
  const ordered = [...rows].sort((a, b) => Number(b.status === "fighting") - Number(a.status === "fighting") || Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const verdict = (b: LiveBattleView) => {
    if (b.status === "fighting") return { text: `round ${b.round} of ${b.totalRounds}`, tone: "text-rose-300" };
    if (b.attackerWon === null || b.attackerWon === undefined) return { text: "over", tone: "text-slate-400" };
    const won = b.attackerWon;
    const iAttacked = b.attackerPlayerId === me;
    const iDefended = b.defenderPlayerId === me;
    const good = (iAttacked && won) || (iDefended && !won);
    const text = b.conquered ? `${b.attackerName} took it` : won ? `${b.attackerName} won` : `${b.defenderName} held`;
    return { text, tone: iAttacked || iDefended ? (good ? "text-emerald-300" : "text-rose-300") : "text-slate-300" };
  };
  const you = (id: string | null) => (id && id === me ? " (you)" : "");
  return (
    <div className="text-sm">
      <p className="px-3 py-2 text-xs text-slate-400">Every battle of the match stays here. Watch replays the fight from the first march; a battle still on shows live.</p>
      {q.isLoading && <p className="px-3 py-2 text-xs text-slate-500">Loading…</p>}
      {!q.isLoading && rows.length === 0 && <p className="px-3 py-2 text-slate-400">No battles yet.</p>}
      <ul className="divide-y divide-slate-900">
        {ordered.map((b) => {
          const v = verdict(b);
          return (
            <li key={b.id} className="flex items-center gap-2 px-3 py-1.5" data-battle-row={b.id}>
              <span className={`shrink-0 ${b.status === "fighting" ? "animate-pulse text-rose-400" : "text-slate-500"}`}>⚔</span>
              <button className="min-w-0 flex-1 text-left hover:text-white" onClick={() => onSelectRegion(b.regionId)} title="Open this region on the map">
                <span className="text-slate-100">
                  {b.mission === "raid" ? "Raid on" : "Battle for"} {regionById(b.regionId)?.name ?? b.regionId}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {b.attackerName}
                  {you(b.attackerPlayerId)} against {b.defenderName}
                  {you(b.defenderPlayerId)} · {new Date(b.startedAt).toLocaleString()} · <span className={v.tone}>{v.text}</span>
                </span>
              </button>
              <button className="shrink-0 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-xs text-rose-100 hover:bg-rose-500/20" onClick={() => onOpenBattle(b.id)} title={b.status === "fighting" ? "Watch the battle live" : "Replay the battle from the first march"}>
                {b.status === "fighting" ? "Watch live" : "Watch ▶"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
