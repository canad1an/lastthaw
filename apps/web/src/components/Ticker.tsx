import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { regionById } from "@lastthaw/shared";

export interface FeedItem {
  id: string;
  at: string;
  kind: string;
  text: string;
  regionId: string | null;
  playerId: string | null;
}

const ICON: Record<string, string> = {
  "ice.advanced": "❄",
  "storm.warning": "🌬",
  "storm.hit": "🌨",
  "thaw.pocket": "☀",
  "plague.outbreak": "☠",
  "refugees.arrived": "🚶",
  "refugees.lost": "🚶",
  "horde.sighted": "⚔",
  "boom.found": "⛏",
  "wonder.started": "🔥",
  "milestone": "🏅",
  "age.advanced": "📜",
  "expedition.returned": "🧭",
  "pact.made": "🤝",
  "pact.ending": "🤝",
  "tribute.paid": "💰",
  "tribute.refused": "💰",
  "bounty.placed": "🎯",
  "bounty.claimed": "🎯",
  "objective.won": "🏆",
  "mercenaries.hired": "🗡",
  "last.stand": "🏳",
  "player.eliminated": "✖",
  "match.finished": "🏆",
};

export function useFeed(matchId: string, nudge: unknown) {
  const q = useQuery({
    queryKey: ["feed", matchId],
    queryFn: () => fetch(`/api/matches/${matchId}/feed`, { credentials: "include" }).then((r) => (r.ok ? (r.json() as Promise<{ items: FeedItem[] }>) : { items: [] })),
    refetchInterval: 30_000,
  });
  useEffect(() => {
    void q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudge]);
  return q.data?.items ?? [];
}

/** What is happening in the world: the newest public event, rotating through the last few, with the whole list a tap away. */
export function Ticker({ matchId, nudge, onSelectRegion }: { matchId: string; nudge: unknown; onSelectRegion: (id: string) => void }) {
  const items = useFeed(matchId, nudge);
  const [i, setI] = useState(0);
  const [open, setOpen] = useState(false);
  const recent = items.slice(0, 8);
  useEffect(() => {
    if (recent.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % recent.length), 6000);
    return () => clearInterval(t);
  }, [recent.length]);
  if (items.length === 0) return null;
  const cur = recent[i % recent.length]!;
  const ago = (iso: string) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  };
  return (
    <div className="relative border-b border-slate-800 bg-slate-950/80 text-xs">
      <button className="flex h-7 w-full items-center gap-2 px-3 text-left hover:bg-slate-900" onClick={() => setOpen((o) => !o)} title="What is happening in the world">
        <span className="shrink-0 text-amber-300" aria-hidden>
          {ICON[cur.kind] ?? "•"}
        </span>
        <span className="min-w-0 flex-1 truncate text-slate-200">{cur.text}</span>
        <span className="shrink-0 text-slate-500">{ago(cur.at)}</span>
        <span className="shrink-0 text-slate-500">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="absolute inset-x-0 top-7 z-40 max-h-[60vh] overflow-y-auto border-b border-slate-700 bg-slate-950 shadow-2xl">
          <ul className="divide-y divide-slate-800">
            {items.map((it) => (
              <li key={it.id} className="flex items-start gap-2 px-3 py-1.5">
                <span className="w-4 shrink-0 text-amber-300" aria-hidden>
                  {ICON[it.kind] ?? "•"}
                </span>
                <span className="min-w-0 flex-1 text-slate-200">
                  {it.text}
                  {it.regionId && regionById(it.regionId) && (
                    <button className="ml-2 text-sky-300 hover:underline" onClick={() => { onSelectRegion(it.regionId!); setOpen(false); }}>
                      show
                    </button>
                  )}
                </span>
                <span className="shrink-0 text-slate-500">{ago(it.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
