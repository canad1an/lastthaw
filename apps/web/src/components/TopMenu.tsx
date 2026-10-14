import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { MessagesList, messageIcon, useMessageToast } from "./Messages.js";
import { AlliancePanel } from "./AlliancePanel.js";
import { Chat } from "./Chat.js";
import { MarketPanel } from "./MarketPanel.js";
import { ageName } from "./RegionPanel.js";
import { LeaderboardTable } from "../routes/leaderboard.js";
import { OVERLAYS, OVERLAY_HINT } from "../map/overlays.js";

type Menu = "messages" | "alliance" | "chat" | "market" | "players" | "leaderboard" | "view";

/**
 * Slim menu bar above the map: Messages (with a 5-second toast for new ones),
 * Alliance, Chat, Market and Players, each opening a dropdown panel.
 */
export function TopMenu({
  matchId,
  state,
  selectedRegionId,
  colorOf,
  overlays,
  onToggleOverlay,
}: {
  matchId: string;
  state: MatchStateView;
  selectedRegionId: string | null;
  colorOf: (id: string) => string;
  overlays: Set<string>;
  onToggleOverlay: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Menu | null>(null);
  const { q, toast, clearToast } = useMessageToast(matchId, open === "messages");
  const markRead = useMutation({ mutationFn: () => api.markMessagesRead(matchId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.messages(matchId) }) });
  const unread = q.data?.unread ?? 0;
  const newest = q.data?.messages[0] ?? null;
  const invites = state.me.allianceId ? 0 : (state as { invites?: unknown[] }).invites?.length ?? 0;

  const toggle = (m: Menu) => {
    setOpen((o) => (o === m ? null : m));
    clearToast();
    if (m === "messages" && open !== "messages" && unread) markRead.mutate();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Tab = ({ id, label, badge, tone }: { id: Menu; label: string; badge?: string | number | undefined; tone?: "alert" | undefined }) => (
    <button
      onClick={() => toggle(id)}
      className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-sm ${open === id ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800 hover:text-white"}`}
    >
      <span>{label}</span>
      {badge !== undefined && badge !== 0 && badge !== "" && (
        <span className={`rounded px-1.5 py-0.5 text-xs ${tone === "alert" ? "bg-rose-500/30 text-rose-200" : "bg-slate-700 text-slate-300"}`}>{badge}</span>
      )}
    </button>
  );

  return (
    <div className="relative z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
      <div className="flex h-10 items-center gap-1 overflow-x-auto px-2">
        <Tab id="messages" label="Messages" badge={unread ? `${unread} new` : undefined} tone="alert" />
        <Tab id="alliance" label="Alliance" badge={state.me.allianceTag ? `[${state.me.allianceTag}]` : invites ? `${invites} invite` : undefined} />
        <Tab id="chat" label="Chat" />
        <Tab id="market" label="Market" />
        <Tab id="players" label="Players" badge={state.players.length} />
        <Tab id="leaderboard" label="Leaderboard" />
        <Tab id="view" label="View" badge={overlays.size || undefined} />
        <div className="mx-2 h-5 w-px bg-slate-800" />
        {toast ? (
          <button className="min-w-0 flex-1 truncate text-left text-sm text-slate-100" onClick={() => toggle("messages")}>
            <span className="mr-2">{messageIcon(toast.kind)}</span>
            {toast.subject}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-slate-500">{newest ? `Latest: ${newest.subject}` : ""}</span>
        )}
      </div>
      {open && (
        <Dropdown onClose={() => setOpen(null)}>
          {open === "messages" && <MessagesList messages={q.data?.messages ?? []} />}
          {open === "alliance" && (
            <div className="p-3">
              <AlliancePanel matchId={matchId} state={state} />
            </div>
          )}
          {open === "chat" && (
            <div className="p-3">
              <Chat matchId={matchId} state={state} />
            </div>
          )}
          {open === "market" && (
            <div className="p-3">
              <MarketPanel matchId={matchId} state={state} selectedRegionId={selectedRegionId} />
            </div>
          )}
          {open === "leaderboard" && (
            <div className="overflow-x-auto">
              <LeaderboardTable matchId={matchId} compact />
            </div>
          )}
          {open === "view" && (
            <div className="space-y-1 p-3 text-sm">
              <p className="mb-2 text-xs text-slate-400">Map overlays. Each marks your regions with a badge; several can be on at once.</p>
              {OVERLAYS.map((o) => (
                <label key={o.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-slate-900">
                  <input type="checkbox" checked={overlays.has(o.id)} onChange={() => onToggleOverlay(o.id)} className="mt-1 accent-sky-400" />
                  <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-slate-950" style={{ background: o.colour }}>
                    {o.glyph}
                  </span>
                  <span>
                    <span className="text-slate-100">{o.label}</span>
                    <span className="block text-xs text-slate-400">{o.description}</span>
                  </span>
                </label>
              ))}
              <p className="pt-1 text-xs text-slate-500">{OVERLAY_HINT}</p>
            </div>
          )}
          {open === "players" && (
            <ul className="divide-y divide-slate-900 text-sm">
              {[...state.players]
                .sort((a, b) => b.score - a.score || b.regions - a.regions)
                .map((p, i) => (
                  <li key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-slate-300">
                    <span className="w-5 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorOf(p.id) }} />
                    <span className={p.id === state.me.playerId ? "text-white" : ""}>{p.name}</span>
                    <span className="text-xs text-slate-500">
                      {ageName(p.age)}
                      {p.aiLevel ? ` · AI ${p.aiLevel}` : ""}
                    </span>
                    <span className="ml-auto tabular-nums text-slate-500">{p.regions} regions</span>
                    <span className="w-16 text-right tabular-nums text-slate-400">{p.score} pts</span>
                  </li>
                ))}
            </ul>
          )}
        </Dropdown>
      )}
    </div>
  );
}

function Dropdown({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute left-0 right-0 top-full z-30 max-h-[65vh] overflow-y-auto border-b border-slate-800 bg-slate-950 shadow-2xl lg:left-2 lg:right-auto lg:w-[34rem] lg:rounded-b-md lg:border-x">{children}</div>
    </>
  );
}
