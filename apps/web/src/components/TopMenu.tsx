import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ageTheme } from "../ageTheme.js";
import { useChatWatch, type ChatToast } from "./chatWatch.js";
import { TECHS, balance, regionById, type MatchStateView } from "@lastthaw/shared";
import { api, keys, type MessageView } from "../api/client.js";
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
import { AdvisorsPanel } from "./AdvisorsPanel.js";

export type MenuId = "messages" | "alliance" | "chat" | "market" | "players" | "leaderboard" | "view" | "empire" | "logistics" | "advisors" | "tech";
type Menu = MenuId | "menu";

export interface MenuEntry {
  id: MenuId;
  label: string;
  badge?: string | number | undefined;
  tone?: "alert" | undefined;
}
/** The region a message is about, when it names one. */
export function regionOf(m: { payload?: unknown }): string | undefined {
  const id = (m.payload as { regionId?: unknown } | null | undefined)?.regionId;
  return typeof id === "string" ? id : undefined;
}

export interface MenuData {
  entries: MenuEntry[];
  /** How many of the entries want attention right now. */
  alerts: number;
  messages: MessageView[];
  newest: MessageView | null;
  toast: { kind: string; subject: string; regionId?: string | undefined } | null;
  clearToast: () => void;
  /** A chat line just in, for the bar; null once it has been shown a few seconds or chat is muted. */
  chatToast: ChatToast | null;
  clearChatToast: () => void;
}

/**
 * The numbers behind the menu: unread mail, open market offers, logistics trouble, pacts to answer.
 * Both layouts read it, the desktop bar and the phone's tab bar and menu grid.
 */
export function useMenuData(matchId: string, state: MatchStateView, overlays: Set<string>, inboxOpen: boolean, chatOpen: boolean): MenuData {
  const qc = useQueryClient();
  const { q, toast, clearToast } = useMessageToast(matchId, inboxOpen);
  const chat = useChatWatch(matchId, state, chatOpen);
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
  // Whatever opened the inbox (the menu, the badge, the toast), reading it clears the unread count.
  useEffect(() => {
    if (inboxOpen && (q.data?.messages ?? []).some((m) => !m.readAt) && !markRead.isPending) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxOpen, q.data]);
  const hiredAdvisors = state.advisors.length;
  const exposedHigh = state.advisors.some((a) => a.kind === "military" && (a.lastReport?.exposed ?? []).some((e) => e.exposure >= 2));
  const iceSoon = state.advisors.some((a) => a.kind === "thaw" && (a.lastReport?.clock ?? []).some((l) => l.hoursLeft <= a.settings.warningHours));
  const advisorBadge = state.advisors.some((a) => a.unpaid) ? "unpaid" : iceSoon ? "ice" : exposedHigh ? "exposed" : hiredAdvisors ? `${hiredAdvisors} hired` : undefined;
  const entries: MenuEntry[] = [
    { id: "messages", label: "Messages", badge: unread ? `${unread} new` : undefined, tone: "alert" },
    { id: "alliance", label: "Alliance", badge: proposals ? `${proposals} to answer` : state.me.allianceTag ? `[${state.me.allianceTag}]` : invites ? `${invites} invite` : undefined, tone: proposals ? "alert" : undefined },
    { id: "chat", label: "Chat", badge: chat.unread ? `${chat.unread} new` : chat.mutedAll ? "muted" : undefined, tone: chat.unread ? "alert" : undefined },
    { id: "market", label: "Market", badge: marketOpen || undefined },
    { id: "players", label: "Players", badge: state.players.length },
    { id: "leaderboard", label: "Leaderboard" },
    { id: "empire", label: "Resources", badge: state.owned.length },
    { id: "logistics", label: "Logistics", badge: logisticsBadge, tone: logisticsBadge ? "alert" : undefined },
    { id: "advisors", label: "Advisors", badge: advisorBadge, tone: state.advisors.some((a) => a.unpaid) || exposedHigh || iceSoon ? "alert" : undefined },
    { id: "tech", label: "Tech", badge: `${state.me.techs.length}/${TECHS.length}` },
    { id: "view", label: "View", badge: overlays.size || undefined },
  ];
  const alerts = (unread ? 1 : 0) + (chat.unread ? 1 : 0) + (logisticsBadge ? 1 : 0) + (invites ? 1 : 0) + (proposals ? 1 : 0);
  return { entries, alerts, messages: q.data?.messages ?? [], newest, toast: toast ? { kind: toast.kind, subject: toast.subject, regionId: regionOf(toast) } : null, clearToast, chatToast: chat.toast, clearChatToast: chat.clearToast };
}

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
  const [open, setOpen] = useState<Menu | null>(null);
  const { entries, alerts, messages, newest, toast, clearToast, chatToast, clearChatToast } = useMenuData(matchId, state, overlays, open === "messages", open === "chat");
  const toggle = (m: Menu) => {
    setOpen((o) => (o === m ? null : m));
    clearToast();
    clearChatToast();
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

  const latest = toast ? (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button className="min-w-0 flex-1 truncate text-left text-sm text-slate-100" onClick={() => toggle("messages")}>
        <span className="mr-2">{messageIcon(toast.kind)}</span>
        {toast.subject}
      </button>
      {toast.regionId && (
        <button
          className="shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-500/20"
          onClick={() => {
            onSelectRegion(toast.regionId!);
            clearToast();
          }}
          title="Centre the map on this region and open it"
        >
          Open region →
        </button>
      )}
    </div>
  ) : chatToast ? (
    <button className="min-w-0 flex-1 truncate text-left text-sm text-slate-100" onClick={() => toggle("chat")} title="Open the chat">
      <span className="mr-2">💬</span>
      <span className="text-sky-200">{chatToast.playerName}:</span> {chatToast.body}
    </button>
  ) : (
    <span className="min-w-0 flex-1 truncate text-sm text-slate-500">{newest ? `Latest: ${newest.subject}` : ""}</span>
  );

  return (
    <div className="age-bar relative z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
      {/* Phones: one Menu button and the latest message on its own row. Wider screens: the full tab row. */}
      <div className="flex h-11 items-center gap-2 px-2 sm:hidden">
        <button onClick={() => toggle("menu")} className={`flex h-9 shrink-0 items-center gap-2 rounded-md border border-slate-700 px-3 text-sm ${open ? "bg-slate-800 text-white" : "text-slate-200"}`}>
          <span aria-hidden>☰</span> Menu
          {alerts > 0 && <span className="rounded bg-rose-500/30 px-1.5 py-0.5 text-xs text-rose-200">{alerts}</span>}
        </button>
        <AgeChip age={state.me.age} compact />
        {latest}
      </div>
      <div className="hidden h-10 items-center gap-1 overflow-x-auto px-2 sm:flex">
        {state.observer ? <span className="inline-flex h-7 shrink-0 items-center rounded-md border border-violet-400/50 bg-violet-500/10 px-2 text-xs font-medium text-violet-100" title="You are looking in as an admin: every region, army and march is in view, and nothing here can be changed">Admin view</span> : <AgeChip age={state.me.age} />}
        <ObjectiveChip state={state} onOpen={() => toggle("players")} />
        <div className="mx-1 h-5 w-px bg-slate-800" />
        {entries.map((e) => (
          <Tab key={e.id} id={e.id} label={e.label} badge={e.badge} tone={e.tone} />
        ))}
        <div className="mx-2 h-5 w-px bg-slate-800" />
        {latest}
      </div>
      <Ticker matchId={matchId} nudge={state.match.now} onSelectRegion={onSelectRegion} />
      {open && (
        <Dropdown onClose={() => setOpen(null)} title={{ messages: "Messages", alliance: "Alliance", chat: "Chat", market: "Market", players: "Players", leaderboard: "Leaderboard", view: "View", empire: "Resources", logistics: "Logistics", advisors: "Advisors", tech: "Tech tree", menu: "Menu" }[open]}>
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
          {open !== "menu" && (
            <MenuPanelBody
              menu={open}
              matchId={matchId}
              state={state}
              selectedRegionId={selectedRegionId}
              colorOf={colorOf}
              overlays={overlays}
              onToggleOverlay={onToggleOverlay}
              onSelectRegion={(id) => {
                onSelectRegion(id);
                setOpen(null);
              }}
              clockOffsetMs={clockOffsetMs}
              messages={messages}
            />
          )}
        </Dropdown>
      )}
    </div>
  );
}

/** One menu's contents, the same on the desktop's dropdown and a phone's screen. */
export function MenuPanelBody({
  menu,
  matchId,
  state,
  selectedRegionId,
  colorOf,
  overlays,
  onToggleOverlay,
  onSelectRegion,
  clockOffsetMs,
  messages,
}: {
  menu: MenuId;
  matchId: string;
  state: MatchStateView;
  selectedRegionId: string | null;
  colorOf: (id: string) => string;
  overlays: Set<string>;
  onToggleOverlay: (id: string) => void;
  onSelectRegion: (regionId: string) => void;
  clockOffsetMs: number;
  messages: MessageView[];
}) {
  return (
    <>
        {menu === "messages" && <MessagesList messages={messages} matchId={matchId} pinned={<ObjectiveCard state={state} />} onSelectRegion={onSelectRegion} />}
        {menu === "alliance" && (
          <div className="p-3">
            <AlliancePanel matchId={matchId} state={state} />
            <div className="mt-4 border-t border-slate-800 pt-3">
              <DiplomacyPanel matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} />
            </div>
          </div>
        )}
        {menu === "chat" && (
          <div className="p-3">
            <Chat matchId={matchId} state={state} />
          </div>
        )}
        {menu === "market" && (
          <div className="p-3">
            <MarketPanel matchId={matchId} state={state} selectedRegionId={selectedRegionId} />
          </div>
        )}
        {menu === "leaderboard" && (
          <div className="overflow-x-auto">
            <LeaderboardTable matchId={matchId} compact />
          </div>
        )}
        {menu === "tech" && <TechTreePanel matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} />}
        {menu === "logistics" && (
          <LogisticsPanel
            state={state}
            onSelect={onSelectRegion}
          />
        )}
        {menu === "advisors" && <AdvisorsPanel matchId={matchId} state={state} onSelect={onSelectRegion} clockOffsetMs={clockOffsetMs} />}
        {menu === "empire" && (
          <EmpirePanel matchId={matchId} state={state} onSelect={onSelectRegion} />
        )}
        {menu === "view" && (
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
        {menu === "players" && state.match.createdByMe && !state.match.tournament && state.match.status === "running" && <EndGame matchId={matchId} name={state.match.name} />}
      {menu === "players" && (state.objective || state.bounties.length > 0) && (
          <div className="space-y-1 border-b border-slate-800 px-3 py-2 text-xs text-slate-300">
            {state.objective && (
              <p>
                🎯 <b className="text-slate-200">Day {state.objective.day}:</b> {state.objective.label} <span className="text-emerald-300">+{balance.win.milestones.daily ?? 100}</span>
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
        {menu === "players" && (
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
    </>
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

/** The age's emblem and name in its colour: the one thing on the bar that changes as the match goes on. */
export function AgeChip({ age, compact }: { age: number; compact?: boolean }) {
  const t = ageTheme(age);
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium" style={{ borderColor: "var(--age-accent)", background: "var(--age-soft)", color: "var(--age-text)" }} title={`${t.name} Age`}>
      <span aria-hidden>{t.emblem}</span>
      {!compact && <span>{t.name} Age</span>}
    </span>
  );
}

/** Today's objective and what it pays, in the bar where nobody can miss it; a tap opens the standings with the details. */
export function ObjectiveChip({ state, onOpen, compact }: { state: MatchStateView; onOpen: () => void; compact?: boolean }) {
  const o = state.objective;
  if (!o) return null;
  const prize = balance.win.milestones.daily ?? 100;
  const yesterday = o.yesterday ? `Yesterday (${o.yesterday.label}): ${o.yesterday.playerId ? (state.players.find((p) => p.id === o.yesterday?.playerId)?.name ?? "someone") : "nobody"}` : "";
  return (
    <button
      onClick={onOpen}
      className="inline-flex h-7 min-w-0 shrink items-center gap-1 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 text-xs font-medium text-amber-100 hover:bg-amber-400/20"
      title={`Day ${o.day}'s objective: ${o.label}. The best player at the day's end scores +${prize}. ${yesterday}`}
    >
      <span aria-hidden>🎯</span>
      <span className="truncate">{compact ? o.label.replace(/ at day's end| in the day/i, "") : `Today: ${o.label}`}</span>
      <span className="shrink-0 text-emerald-300">+{prize}</span>
    </button>
  );
}

/** Today's goal, pinned at the top of the inbox: what it is, what it pays, who took yesterday's. */
export function ObjectiveCard({ state }: { state: MatchStateView }) {
  const o = state.objective;
  if (!o) return null;
  const prize = balance.win.milestones.daily ?? 100;
  const winner = o.yesterday?.playerId ? (state.players.find((p) => p.id === o.yesterday?.playerId)?.name ?? "someone") : null;
  return (
    <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm">
      <p className="font-medium text-amber-100">
        🎯 Day {o.day}'s goal: {o.label} <span className="text-emerald-300">+{prize}</span>
      </p>
      <p className="mt-0.5 text-xs text-amber-200/80">
        The best tribe at the day's end takes the points. {o.yesterday ? `Yesterday (${o.yesterday.label}): ${winner ?? "nobody"}${o.yesterday.value ? ` with ${o.yesterday.value}` : ""}.` : ""}
      </p>
    </div>
  );
}

/** The creator's way out: end the game now. It finishes with no winner and its report stays at its address. */
function EndGame({ matchId, name }: { matchId: string; name: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const m = useMutation({
    mutationFn: () => api.endMatch(matchId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
      void qc.invalidateQueries({ queryKey: keys.matches });
      void nav({ to: "/match/$matchId/report", params: { matchId } });
    },
  });
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2 text-xs text-slate-400">
      <span>You made this game. You can end it at any time; it finishes with no winner and its report stays.</span>
      <button className="rounded border border-rose-500/50 bg-rose-500/10 px-2 py-1 text-rose-200 hover:bg-rose-500/20 disabled:opacity-50" disabled={m.isPending} onClick={() => setConfirming(true)}>
        End game
      </button>
      {m.error && <span className="text-rose-300">{m.error.message}</span>}
      {confirming &&
        createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" onClick={() => setConfirming(false)} role="dialog" aria-modal="true" aria-labelledby="end-game-title">
          <div className="w-full max-w-md rounded-2xl border border-rose-500/40 bg-slate-950 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 id="end-game-title" className="text-lg font-semibold text-white">
              End this game?
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Are you sure you want to end <span className="text-white">{name}</span> for everyone? This cannot be undone. The game finishes now with no winner, and its report stays at its address.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800" onClick={() => setConfirming(false)} autoFocus>
                Cancel
              </button>
              <button
                className="rounded-md border border-rose-500/50 bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/30 disabled:opacity-50"
                disabled={m.isPending}
                onClick={() => {
                  setConfirming(false);
                  m.mutate();
                }}
              >
                Yes, end the game
              </button>
            </div>
          </div>
        </div>,
          document.body,
        )}
    </div>
  );
}
