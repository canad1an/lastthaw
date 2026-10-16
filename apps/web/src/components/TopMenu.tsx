import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { TECHS, regionById, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { MessagesList, isImportant, messageIcon, useMessageToast } from "./Messages.js";
import { AlliancePanel } from "./AlliancePanel.js";
import { Chat } from "./Chat.js";
import { MarketPanel } from "./MarketPanel.js";
import { ageName } from "./RegionPanel.js";
import { LeaderboardTable } from "../routes/leaderboard.js";
import { OVERLAYS, OVERLAY_HINT } from "../map/overlays.js";
import { EmpirePanel } from "./EmpirePanel.js";
import { LogisticsPanel } from "./LogisticsPanel.js";
import { TechTreePanel } from "./TechTreePanel.js";
import { Ticker } from "./Ticker.js";
import { DiplomacyPanel } from "./DiplomacyPanel.js";

type Menu = "messages" | "alliance" | "chat" | "market" | "players" | "leaderboard" | "view" | "empire" | "logistics" | "tech" | "menu";

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
  onSelectRegion,
  clockOffsetMs,
}: {
  matchId: string;
  state: MatchStateView;
  selectedRegionId: string | null;
  colorOf: (id: string) => string;
  overlays: Set<string>;
  onToggleOverlay: (id: string) => void;
  onSelectRegion: (regionId: string) => void;
  clockOffsetMs: number;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Menu | null>(null);
  const { q, toast, clearToast } = useMessageToast(matchId, open === "messages");
  const markRead = useMutation({ mutationFn: () => api.markMessagesRead(matchId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.messages(matchId) }) });
  // Only important unread messages count toward the alert badge; the rest sit quietly in the inbox.
  const unread = (q.data?.messages ?? []).filter((m) => !m.readAt && isImportant(m)).length;
  const newest = q.data?.messages[0] ?? null;
  const invites = state.me.allianceId ? 0 : (state as { invites?: unknown[] }).invites?.length ?? 0;
  const proposals = state.pacts.filter((p) => p.status === "proposed" && p.bPlayerId === state.me.playerId).length;

  // Routes waiting on haulers plus builds waiting on materials: the number that needs attention.
  const logisticsBadge =
    state.routes.filter((r) => r.enabled && (r.lastResult ?? "").startsWith("no haulers at home")).length + state.jobs.filter((j) => j.kind === "build" && j.waitingFor).length || undefined;
  // Open offers on the market (everyone's, including mine), refreshed every half minute.
  const marketQ = useQuery({ queryKey: keys.market(matchId), queryFn: () => api.market(matchId), refetchInterval: 30_000 });
  const marketOpen = (marketQ.data?.open.length ?? 0) + (marketQ.data?.mine.filter((o) => o.status === "open" && !marketQ.data?.open.some((x) => x.id === o.id)).length ?? 0);
  const toggle = (m: Menu) => {
    setOpen((o) => (o === m ? null : m));
    clearToast();
  };
  // Whatever opened the inbox (the menu, the badge, the toast), reading it clears the unread count.
  useEffect(() => {
    if (open === "messages" && (q.data?.messages ?? []).some((m) => !m.readAt) && !markRead.isPending) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q.data]);
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

  const entries: Array<{ id: Menu; label: string; badge?: string | number | undefined; tone?: "alert" | undefined }> = [
    { id: "messages", label: "Messages", badge: unread ? `${unread} new` : undefined, tone: "alert" },
    { id: "alliance", label: "Alliance", badge: proposals ? `${proposals} to answer` : state.me.allianceTag ? `[${state.me.allianceTag}]` : invites ? `${invites} invite` : undefined, tone: proposals ? "alert" : undefined },
    { id: "chat", label: "Chat" },
    { id: "market", label: "Market", badge: marketOpen || undefined },
    { id: "players", label: "Players", badge: state.players.length },
    { id: "leaderboard", label: "Leaderboard" },
    { id: "empire", label: "Resources", badge: state.owned.length },
    { id: "logistics", label: "Logistics", badge: logisticsBadge, tone: logisticsBadge ? "alert" : undefined },
    { id: "tech", label: "Tech", badge: `${state.me.techs.length}/${TECHS.length}` },
    { id: "view", label: "View", badge: overlays.size || undefined },
  ];
  const alerts = (unread ? 1 : 0) + (logisticsBadge ? 1 : 0) + (invites ? 1 : 0) + (proposals ? 1 : 0);
  const latest = toast ? (
    <button className="min-w-0 flex-1 truncate text-left text-sm text-slate-100" onClick={() => toggle("messages")}>
      <span className="mr-2">{messageIcon(toast.kind)}</span>
      {toast.subject}
    </button>
  ) : (
    <span className="min-w-0 flex-1 truncate text-sm text-slate-500">{newest ? `Latest: ${newest.subject}` : ""}</span>
  );

  return (
    <div className="relative z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
      {/* Phones: one Menu button and the latest message on its own row. Wider screens: the full tab row. */}
      <div className="flex h-11 items-center gap-2 px-2 sm:hidden">
        <button onClick={() => toggle("menu")} className={`flex h-9 shrink-0 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm ${open ? "bg-slate-800 text-white" : "text-slate-200"}`}>
          <span aria-hidden>☰</span> Menu
          {alerts > 0 && <span className="rounded bg-rose-500/30 px-1.5 py-0.5 text-xs text-rose-200">{alerts}</span>}
        </button>
        {latest}
      </div>
      <div className="hidden h-10 items-center gap-1 overflow-x-auto px-2 sm:flex">
        {entries.map((e) => (
          <Tab key={e.id} id={e.id} label={e.label} badge={e.badge} tone={e.tone} />
        ))}
        <div className="mx-2 h-5 w-px bg-slate-800" />
        {latest}
      </div>
      <Ticker matchId={matchId} nudge={state.match.now} onSelectRegion={onSelectRegion} />
      {open && (
        <Dropdown onClose={() => setOpen(null)} title={{ messages: "Messages", alliance: "Alliance", chat: "Chat", market: "Market", players: "Players", leaderboard: "Leaderboard", view: "View", empire: "Resources", logistics: "Logistics", tech: "Tech tree", menu: "Menu" }[open]}>
          {open === "menu" && (
            <div className="grid grid-cols-2 gap-2 p-3">
              {entries.map((e) => (
                <button key={e.id} onClick={() => setOpen(e.id)} className="flex min-h-14 items-center justify-between rounded-md border border-slate-700 bg-slate-900 px-3 text-left text-sm text-slate-100 active:bg-slate-800">
                  <span>{e.label}</span>
                  {e.badge !== undefined && e.badge !== 0 && e.badge !== "" && (
                    <span className={`rounded px-1.5 py-0.5 text-xs ${e.tone === "alert" ? "bg-rose-500/30 text-rose-200" : "bg-slate-700 text-slate-300"}`}>{e.badge}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {open === "messages" && <MessagesList messages={q.data?.messages ?? []} />}
          {open === "alliance" && (
            <div className="p-3">
              <AlliancePanel matchId={matchId} state={state} />
              <div className="mt-4 border-t border-slate-800 pt-3">
                <DiplomacyPanel matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} />
              </div>
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
          {open === "tech" && <TechTreePanel matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} />}
          {open === "logistics" && (
            <LogisticsPanel
              state={state}
              onSelect={(id) => {
                onSelectRegion(id);
                setOpen(null);
              }}
            />
          )}
          {open === "empire" && (
            <EmpirePanel
              state={state}
              onSelect={(id) => {
                onSelectRegion(id);
                setOpen(null);
              }}
            />
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
          {open === "players" && (state.objective || state.bounties.length > 0) && (
            <div className="space-y-1 border-b border-slate-800 px-3 py-2 text-xs text-slate-300">
              {state.objective && (
                <p>
                  🎯 <b className="text-slate-200">Day {state.objective.day}:</b> {state.objective.label} <span className="text-emerald-300">+100</span>
                  {state.objective.yesterday && (
                    <span className="text-slate-500">
                      {" "}
                      · yesterday: {state.objective.yesterday.playerId ? (state.players.find((p) => p.id === state.objective?.yesterday?.playerId)?.name ?? "someone") : "nobody"}
                    </span>
                  )}
                </p>
              )}
              {state.bounties.map((b) => (
                <p key={b.id}>
                  💰 <b className="text-amber-200">{b.regionId ? (regionById(b.regionId)?.name ?? b.regionId) : (state.players.find((p) => p.id === b.playerId)?.name ?? "a player")}</b>: {b.reason}. Pays{" "}
                  {Object.entries(b.amount)
                    .map(([k, v]) => `${Math.round(v)} ${k}`)
                    .join(", ")}{" "}
                  to whoever wins a battle there.
                </p>
              ))}
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

/** Every menu opens as a centred overlay on top of the map: wide enough for tables and the tech tree, scrollable, closed by the X, Escape or a click outside. */
function Dropdown({ children, onClose, title }: { children: ReactNode; onClose: () => void; title?: string }) {
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-slate-950/70 p-0 pt-11 backdrop-blur-sm sm:p-6 sm:pt-14" onClick={onClose}>
      <div
        className="flex h-[calc(100dvh-2.75rem)] w-full max-w-6xl flex-col overflow-hidden border-t border-slate-700 bg-slate-950 shadow-2xl sm:h-auto sm:max-h-[88vh] sm:rounded-lg sm:border"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
          <span className="text-sm font-medium text-slate-200">{title}</span>
          <button className="min-h-10 min-w-10 rounded px-2 py-0.5 text-lg text-slate-400 hover:bg-slate-800 hover:text-white" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
