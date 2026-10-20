import type React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePageMeta, useSlugAddress } from "../seo.js";
import { Link, Navigate, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo, useState, useRef } from "react";
import { balance, formatCountdown, iceLatitudeOnDay, regionById, type MapRegion, type MatchStateView, loyaltyBand, wallOf, unitById } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { useMatchRealtime } from "../api/realtime.js";
import { RegionPanel, ageName } from "../components/RegionPanel.js";
import { ageTheme, ageVars } from "../ageTheme.js";
import { usePhone } from "../hooks/usePhone.js";
import { PhoneShell } from "../components/phone/PhoneShell.js";
import { PhoneTabBar } from "../components/phone/PhoneTabBar.js";
import { tabOf, type Screen } from "../components/phone/screens.js";
import { AgeChip, ObjectiveChip, useMenuData } from "../components/TopMenu.js";
import { messageIcon, RealmTakenPopup } from "../components/Messages.js";
import { Ticker } from "../components/Ticker.js";
import type { RegionTab } from "../components/RegionPanel.js";
import { ResearchPanel } from "../components/ResearchPanel.js";
import { TopMenu } from "../components/TopMenu.js";
import { BottomSheet, type SheetStop } from "../components/BottomSheet.js";
import { MatchSummary, useSummaryOpen } from "../components/MatchSummary.js";
import { MatchNight, useWinterNight } from "../components/MatchNight.js";
import { MatchIntro, useIntroOpen } from "../components/MatchIntro.js";
import { RefugeePanel } from "../components/RefugeePanel.js";
import { noteBadges, overlayBadges, useOverlays, advisorBadges, battleBadges } from "../map/overlays.js";
import { BattleWindow } from "../components/BattleWindow.js";
import { IncomingWarnings } from "../components/ArmyPanel.js";
import { ActivityPanel } from "../components/ActivityPanel.js";
import { ChatChannel } from "../components/Chat.js";
import { TradeRoutesPanel } from "../components/TradeRoutesPanel.js";
import { Button, Card, ErrorText, fmt } from "../components/ui.js";
import { useNow } from "../hooks/useNow.js";
import { useServerInfo } from "../hooks/useServerInfo.js";
import { useMe } from "../api/auth.js";
import { WorldMap, terrainFill, type RegionPaint } from "../map/WorldMap.js";
import { armyMarkers } from "../map/armyMarkers.js";

const PLAYER_COLORS = ["#38bdf8", "#f472b6", "#a3e635", "#fb923c", "#c084fc", "#2dd4bf", "#facc15", "#f87171"];

/** How each kind of wall is drawn around a region: thicker, lighter borders as the works get stronger. */
function wallPaint(wall: string | null | undefined): Partial<RegionPaint> {
  switch (wall) {
    case "palisade":
      return { stroke: "#f59e0b", strokeScale: 6, dash: [5, 3] };
    case "walls":
      return { stroke: "#e2e8f0", strokeScale: 8 };
    case "fort":
      return { stroke: "#e2e8f0", strokeScale: 9, inner: "#0b1a2b" };
    case "castle":
      return { stroke: "#f8fafc", strokeScale: 11, dash: [7, 3], inner: "#0b1a2b" };
    case "arsenal":
      return { stroke: "#fde68a", strokeScale: 11, dash: [7, 3], inner: "#0b1a2b" };
    case "bunker":
      return { stroke: "#ffffff", strokeScale: 14, dash: [8, 3], inner: "#334155" };
    default:
      return {};
  }
}

export function MatchPage() {
  const { matchId } = useParams({ from: "/match/$matchId" });
  const state = useQuery({ queryKey: keys.matchState(matchId), queryFn: () => api.matchState(matchId), refetchInterval: 30_000 });
  // The address may be the readable slug; the socket and the match's own links want the id.
  const rt = useMatchRealtime(state.data?.match.id ?? null);
  useSlugAddress(matchId, state.data?.match.slug, "");
  usePageMeta({ title: state.data ? `${state.data.match.name}: the map` : "Match", description: state.data ? `${state.data.match.name}: a Last Thaw match in progress. Thirty days on a freezing Earth.` : undefined, path: `/match/${state.data?.match.slug || matchId}`, noindex: true });

  if (state.isLoading) return <p className="p-6 text-slate-400">Loading match...</p>;
  if (state.error || !state.data) {
    return (
      <main className="p-6">
        <ErrorText>{state.error?.message ?? "Match not found"}</ErrorText>
        <Link to="/" className="text-sky-400 hover:underline">
          Back to matches
        </Link>
      </main>
    );
  }
  const s = state.data;
  if (s.match.status === "lobby") return <Navigate to="/match/$matchId/lobby" params={{ matchId }} replace />;
  return <GameView matchId={matchId} state={s} rtStatus={rt.status} />;
}

/** The waiting room: the countdown, who has joined, the start pick on the map, and a chat, until the match begins. */
export function MatchLobbyPage() {
  const { matchId } = useParams({ from: "/match/$matchId/lobby" });
  const state = useQuery({ queryKey: keys.matchState(matchId), queryFn: () => api.matchState(matchId), refetchInterval: 10_000 });
  useSlugAddress(matchId, state.data?.match.slug, "/lobby");
  usePageMeta({ title: state.data ? `${state.data.match.name}: waiting room` : "Waiting room", path: `/match/${state.data?.match.slug || matchId}/lobby`, noindex: true });
  if (state.isLoading) return <p className="p-6 text-slate-400">Loading lobby...</p>;
  if (state.error || !state.data) {
    return (
      <main className="p-6">
        <ErrorText>{state.error?.message ?? "Match not found"}</ErrorText>
        <Link to="/matches" className="text-sky-400 hover:underline">
          Back to matches
        </Link>
      </main>
    );
  }
  if (state.data.match.status !== "lobby") return <Navigate to="/match/$matchId" params={{ matchId }} replace />;
  return <LobbyRoom matchId={matchId} state={state.data} />;
}

/** The waiting room: countdown, who is here and who is online, chat, and a step out to the map to choose a capital. */
function LobbyRoom({ matchId, state }: { matchId: string; state: MatchStateView }) {
  const now = useNow(1000);
  const [picking, setPicking] = useState(false);
  // Being connected is what "online" means here, so the room keeps the socket open.
  useMatchRealtime(state.match.id);
  const presence = useQuery({
    queryKey: ["presence", matchId],
    queryFn: () => fetch(`/api/matches/${matchId}/presence`, { credentials: "include" }).then((r) => (r.ok ? (r.json() as Promise<{ online: string[] }>) : { online: [] })),
    refetchInterval: 10_000,
  });
  const online = useMemo(() => new Set(presence.data?.online ?? []), [presence.data]);
  const listing = useQuery({ queryKey: keys.matches, queryFn: () => api.matches() });
  const mine = listing.data?.find((m) => m.id === matchId);
  const startsIn = (Date.parse(state.match.startsAt) - now) / 1000;
  const capital = state.me.capitalRegionId ? regionById(state.me.capitalRegionId) : null;
  const qc = useQueryClient();
  const nav = useNavigate();
  const startNow = useMutation({
    mutationFn: () => api.startNow(matchId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
      void qc.invalidateQueries({ queryKey: keys.matches });
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelGame(matchId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.matches });
      void nav({ to: "/matches" });
    },
  });
  if (picking) return <LobbyView matchId={matchId} state={state} onBack={() => setPicking(false)} />;
  const kind = mine ? (mine.kind === "tournament" ? "Tournament" : mine.kind === "private" ? "Private game" : "Public game") : "Game";
  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-sky-300">{kind} · waiting room</p>
          <h1 className="display text-3xl font-bold text-white">{state.match.name}</h1>
          <p className="text-sm text-slate-400">
            {state.match.speed}x{state.match.speed > 1 ? ` (a game day every ${formatCountdown(86400 / state.match.speed)})` : " (real time)"} · {balance.match.lengthDays} days · starts {new Date(state.match.startsAt).toLocaleString()}
          </p>
        </div>
        <Link to="/matches" className="text-sm text-sky-400 hover:underline">
          Back to matches
        </Link>
      </header>
      <div className="grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-4">
          <Card className="text-center">
            <p className="text-xs uppercase tracking-[0.3em] text-sky-300">{startsIn > 0 ? "The ice starts moving in" : "Starting"}</p>
            <p className="display mt-1 text-5xl font-bold tabular-nums text-white">{startsIn > 0 ? formatCountdown(startsIn) : "..."}</p>
            <p className="mt-2 text-sm text-slate-400">You are taken to the map the moment it starts.</p>
          </Card>
          <Card className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-medium text-white">Your capital</h2>
                <p className="text-sm text-slate-400">{capital ? `${capital.name}, ${capital.countryName}` : "Not chosen yet. If you do not choose, one of your options is picked for you at the start."}</p>
              </div>
              <Button onClick={() => setPicking(true)}>{capital ? "Change on the map" : "Choose on the map"}</Button>
            </div>
          </Card>
          {mine?.inviteCode && (
            <Card className="text-sm text-slate-300">
              Invite code <span className="font-mono text-amber-200">{mine.inviteCode}</span>: friends enter it on the Matches page to join.
            </Card>
          )}
          {mine?.createdByMe && mine.kind !== "tournament" && (
            <Card className="space-y-2">
              <h2 className="font-medium text-white">Your game</h2>
              <p className="text-sm text-slate-400">You made this game, so you decide when it begins. Starting now fills the empty seats with AI tribes at once.</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => window.confirm(`Start ${state.match.name} now with ${state.players.length} player${state.players.length === 1 ? "" : "s"} and AI tribes in the rest of the seats?`) && startNow.mutate()} disabled={startNow.isPending}>
                  Start now
                </Button>
                <Button variant="danger" onClick={() => window.confirm(`Cancel ${state.match.name}? Everyone who joined is sent back to the Matches page.`) && cancel.mutate()} disabled={cancel.isPending}>
                  Cancel game
                </Button>
              </div>
              <ErrorText>{startNow.error?.message ?? cancel.error?.message}</ErrorText>
            </Card>
          )}
          <Card className="space-y-2">
            <h2 className="font-medium text-white">Chat</h2>
            <ChatChannel matchId={matchId} channel="global" me={state.me.playerId} />
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 font-medium text-white">
              Here so far <span className="text-sm text-slate-500">({state.players.length} joined, {online.size} online; AI tribes fill the rest to {balance.match.maxHumanPlayers})</span>
            </h2>
            <ul className="space-y-1 text-sm">
              {state.players.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <span className={`inline-block h-2 w-2 rounded-full ${online.has(p.id) ? "bg-emerald-400" : "bg-slate-600"}`} title={online.has(p.id) ? "online" : "away"} />
                  <span className={p.id === state.me.playerId ? "text-sky-300" : "text-slate-200"}>
                    {p.name}
                    {p.id === state.me.playerId ? " (you)" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="text-sm text-slate-400">
            <p className="mb-1 font-medium text-slate-200">While you wait</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                Read the <Link to="/how-to-play" className="text-sky-400 hover:underline">field manual</Link>: ten minutes, and you will know what the first day asks of you.
              </li>
              <li>Nobody can attack you for the first {balance.match.protectionDays} days; use them to build and grow.</li>
              <li>Pick a capital with food nearby and room to expand; the ice comes from the poles, so further south lasts longer.</li>
            </ul>
          </Card>
        </div>
      </div>
    </main>
  );
}

/** Before the match starts: pick a capital from the offered options. */
function LobbyView({ matchId, state, onBack }: { matchId: string; state: MatchStateView; onBack?: () => void }) {
  const qc = useQueryClient();
  const now = useNow(1000);
  const options = useQuery({ queryKey: keys.startOptions(matchId), queryFn: () => api.startOptions(matchId) });
  const [selected, setSelected] = useState<string | null>(null);
  const pick = useMutation({
    mutationFn: (regionId: string) => api.pickStart(matchId, regionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
      void qc.invalidateQueries({ queryKey: keys.startOptions(matchId) });
      void qc.invalidateQueries({ queryKey: keys.matches });
      onBack?.();
    },
  });
  const devStart = useMutation({ mutationFn: () => api.devStart(matchId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  const optionSet = useMemo(() => new Set(options.data?.options ?? []), [options.data]);
  const current = state.me.capitalRegionId;
  const startsIn = (Date.parse(state.match.startsAt) - now) / 1000;

  const paint = useCallback(
    (r: MapRegion): RegionPaint => {
      if (r.id === current) return { fill: "#38bdf8", opacity: 1 };
      if (optionSet.has(r.id)) return { fill: "#facc15", opacity: 0.95 };
      return { opacity: 0.35 };
    },
    [optionSet, current],
  );

  const sel = selected ? regionById(selected) : null;

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col bg-slate-950 lg:flex-row">
      <WorldMap paint={paint} selected={selected} onSelect={setSelected} focus={current ?? options.data?.options[0] ?? null} className="h-1/2 w-full lg:h-full lg:flex-1" />
      <aside className="w-full space-y-3 overflow-y-auto border-t border-slate-800 p-4 lg:w-96 lg:border-l lg:border-t-0">
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            ← Back to the waiting room
          </Button>
        )}
        <h1 className="display text-2xl font-semibold text-white">{state.match.name}</h1>
        <p className="text-sm text-slate-400">{startsIn > 0 ? `Starts in ${formatCountdown(startsIn)}` : "Starting..."} · choose where your five families begin.</p>
        <Card>
          <p className="text-sm text-slate-300">
            Highlighted regions are your starting options. Click one, then confirm. If you do not choose, one is picked for you when the match starts.
          </p>
        </Card>
        {sel && (
          <Card className="space-y-2">
            <h2 className="font-medium">{sel.name}</h2>
            <p className="text-xs text-slate-400">
              {sel.countryName} · {sel.terrain}
              {sel.coastal ? " · coastal" : ""}
              {sel.river ? " · river" : ""}
            </p>
            <p className="text-sm text-slate-300">Resources: {sel.resources.map((r) => r.replace("_", " ")).join(", ")}</p>
            <p className="text-sm text-slate-300">Neighbours: {sel.neighbors.length} by land, {sel.seaRoutes.length} by sea</p>
            {optionSet.has(sel.id) ? (
              <Button onClick={() => pick.mutate(sel.id)} disabled={pick.isPending || sel.id === current}>
                {sel.id === current ? "Your capital" : "Start here"}
              </Button>
            ) : (
              <p className="text-xs text-slate-500">Not one of your options.</p>
            )}
            <ErrorText>{pick.error?.message}</ErrorText>
          </Card>
        )}
        {current && <p className="text-sm text-emerald-400">Capital chosen: {regionById(current)?.name}</p>}
        <DevTools matchId={matchId} lobby onStart={() => devStart.mutate()} />
      </aside>
    </div>
  );
}

function GameView({ matchId, state, rtStatus }: { matchId: string; state: MatchStateView; rtStatus: string }) {
  const now = useNow(1000);
  const [selected, setSelected] = useState<string | null>(state.me.capitalRegionId);
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  // Phone layout: the side panel is a bottom sheet. Selecting a region opens it halfway; tapping the same region again opens it fully.
  const [sheet, setSheet] = useState<SheetStop>("half");
  // Phones: the map is the home screen and everything else is a screen pushed over it, so Back always makes sense.
  const phone = usePhone();
  const [stack, setStack] = useState<Screen[]>([{ kind: "map" }]);
  const screen = stack[stack.length - 1] ?? { kind: "map" };
  const push = useCallback((sc: Screen) => setStack((st) => [...st, sc]), []);
  const pop = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)), []);
  const openRegion = useCallback((id: string) => {
    setSelected(id);
    setTarget(null);
    setStack([{ kind: "map" }, { kind: "region", id, tab: "overview" }]);
  }, []);
  // A message's Open region: select it, centre the map on it and flash it, on either layout.
  const [flyTo, setFlyTo] = useState<{ id: string; n: number } | null>(null);
  const goToRegion = useCallback(
    (id: string) => {
      if (phone) openRegion(id);
      else {
        setSelected(id);
        setTarget(null);
        setSheet("half");
      }
      setFlyTo((f) => ({ id, n: (f?.n ?? 0) + 1 }));
    },
    [phone, openRegion],
  );
  const setRegionTab = useCallback((tab: RegionTab) => setStack((st) => st.map((sc, i) => (i === st.length - 1 && sc.kind === "region" ? { ...sc, tab } : sc))), []);
  // Picking a target on a phone drops back to the map; the pick returns to the region's units tab.
  const returnTo = useRef<Screen | null>(null);
  const onPickTarget = useCallback(
    (p: boolean) => {
      setPicking(p);
      if (p && phone && selected) {
        returnTo.current = { kind: "region", id: selected, tab: "units" };
        setStack([{ kind: "map" }]);
      }
    },
    [phone, selected],
  );
  const cancelPick = () => {
    setPicking(false);
    if (returnTo.current) push(returnTo.current);
    returnTo.current = null;
  };
  const onMapSelect = useCallback(
    (id: string | null) => {
      if (picking && id) {
        setTarget(id);
        setPicking(false);
        setSheet("half");
        if (phone && returnTo.current) {
          push(returnTo.current);
          returnTo.current = null;
        }
      } else if (phone) {
        if (id) openRegion(id);
      } else if (id && id === selected) {
        setSheet("full");
      } else {
        setSelected(id);
        // A new origin region starts with no target, so an army is never sent to a stale one.
        setTarget(null);
        setSheet(id ? "half" : "peek");
      }
    },
    [picking, selected, phone, openRegion, push],
  );
  const onTab = (t: ReturnType<typeof tabOf>) => {
    if (t === "map") setStack([{ kind: "map" }]);
    else if (t === "region") {
      const id = selected ?? state.me.capitalRegionId;
      if (id) openRegion(id);
    } else if (t === "empire") setStack([{ kind: "map" }, { kind: "panel", id: "empire" }]);
    else if (t === "research") setStack([{ kind: "map" }, { kind: "panel", id: "research" }]);
    else setStack([{ kind: "map" }, { kind: "menu" }]);
  };
  // Server-time offset, captured once per state fetch. Recomputing it every render
  // would pin countdowns to the moment the snapshot was taken.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clockOffsetMs = useMemo(() => Date.parse(state.match.now) - Date.now(), [state.match.now]);
  const endsIn = (Date.parse(state.match.endsAt) - (now + clockOffsetMs)) / 1000;
  const [forecast, setForecast] = useState(false);
  const matchDay = Math.min(balance.match.lengthDays, Math.max(0, ((now + clockOffsetMs - Date.parse(state.match.startsAt)) / 86400_000) * state.match.speed));
  const ice = useMemo(() => ({ latitude: iceLatitudeOnDay(matchDay), forecast, day: matchDay }), [matchDay, forecast]);
  const { enabled: overlays, toggle: toggleOverlay } = useOverlays();
  const menu = useMenuData(matchId, state, overlays, phone && screen.kind === "panel" && screen.id === "messages", phone && screen.kind === "panel" && screen.id === "chat");
  const hideHaulers = overlays.has("hidehaulers");
  const shownArmies = useMemo(
    () => (hideHaulers ? state.armies.filter((a) => a.mission === "relocate" || !Object.entries(a.units).every(([id, n]) => n <= 0 || unitById.get(id)?.hauler)) : state.armies),
    [state.armies, hideHaulers],
  );
  const markers = useMemo(() => armyMarkers(shownArmies, state.incoming, now + clockOffsetMs, formatCountdown, state.me.techs), [shownArmies, state.incoming, now, clockOffsetMs]);
  const finished = state.match.status === "finished";
  const eliminated = state.owned.length === 0 && !finished;
  const [summaryOpen, setSummaryOpen] = useSummaryOpen(matchId, finished);
  const [night, leaveNight] = useWinterNight(matchId, finished ? state.match.finishedAt : null);
  const [introOpen, setIntroOpen] = useIntroOpen(matchId, !finished && !eliminated);

  // Colours follow join order (the server returns players in that order) and never change during a match.
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    state.players.forEach((p, i) => m.set(p.id, PLAYER_COLORS[i % PLAYER_COLORS.length]!));
    return (id: string) => m.get(id) ?? "#999";
  }, [state.players]);
  const ownedSet = useMemo(() => new Set(state.owned.map((o) => o.regionId)), [state.owned]);
  const ownedById = useMemo(() => new Map(state.owned.map((o) => [o.regionId, o])), [state.owned]);
  const badges = useMemo(() => [...noteBadges(state), ...advisorBadges(state), ...battleBadges(state), ...overlayBadges(state, overlays, matchDay)], [state, overlays, matchDay]);
  const [battleId, setBattleId] = useState<string | null>(null);
  // A battle that ends while its window is open stays on screen with the verdict; one that is gone from the list when the window opens is still readable by id.
  const sightedBy = useMemo(() => new Map(state.sighted.map((s) => [s.regionId, s])), [state.sighted]);

  const incomingSet = useMemo(() => new Set(state.incoming.map((i) => i.targetRegionId)), [state.incoming]);
  // Road links: between adjacent regions that both have Roads, among mine and what I can see.
  const roadLinks = useMemo(() => {
    const colour = new Map<string, string>();
    const rail = new Set<string>();
    for (const o of state.owned) {
      if (o.frozen) continue;
      if ((o.buildings.roads ?? 0) >= 1) colour.set(o.regionId, colorOf(state.me.playerId));
      if ((o.buildings.railway ?? 0) >= 1) rail.add(o.regionId);
    }
    for (const s of state.sighted) if (s.roads && !colour.has(s.regionId)) colour.set(s.regionId, "#cbd5e1");
    const out: Array<[string, string, string, "road" | "rail"]> = [];
    for (const [id, c] of colour) {
      for (const n of regionById(id)?.neighbors ?? []) {
        if (id < n && colour.has(n)) {
          const both = rail.has(id) && rail.has(n);
          out.push([id, n, both ? "#f8fafc" : c === colour.get(n) ? c : "#cbd5e1", both ? "rail" : "road"]);
        }
      }
    }
    return out;
  }, [state.owned, state.sighted, state.me.playerId, colorOf]);
  const frontierSet = useMemo(() => new Set(state.frontier), [state.frontier]);
  const allySet = useMemo(() => new Set(state.allies), [state.allies]);
  const borderSet = useMemo(() => new Set(state.owned.flatMap((o) => regionById(o.regionId)?.neighbors ?? [])), [state.owned]);
  const paint = useCallback(
    (r: MapRegion): RegionPaint => {
      if (r.id === target) return { fill: "#facc15", opacity: 1, stroke: "#fff" };
      if (ownedSet.has(r.id)) {
        const o = ownedById.get(r.id);
        const walls = wallPaint(wallOf(o?.buildings));
        if (overlays.has("loyalty")) {
          if (o && !o.isCapital) {
            const band = loyaltyBand(o.loyalty);
            return { fill: band === "secure" ? "#22c55e" : band === "uneasy" ? "#f59e0b" : "#ef4444", opacity: 1, ...walls, ...(incomingSet.has(r.id) ? { stroke: "#f43f5e" } : {}) };
          }
        }
        return { fill: colorOf(state.me.playerId), opacity: 1, ...walls, ...(incomingSet.has(r.id) ? { stroke: "#f43f5e" } : {}) };
      }
      const s = sightedBy.get(r.id);
      if (s) {
        const walls = wallPaint(s.wall);
        // An enemy next door is painted red so the front line reads at a glance.
        const enemy = !!s.ownerPlayerId && s.ownerPlayerId !== state.me.playerId && !allySet.has(s.ownerPlayerId) && borderSet.has(r.id);
        if (enemy) return { fill: "#b91c1c", opacity: 0.85, stroke: "#fca5a5", ...walls };
        return { fill: s.ownerPlayerId ? colorOf(s.ownerPlayerId) : terrainFill(r.terrain), opacity: 0.8, ...walls };
      }
      if (frontierSet.has(r.id)) return { opacity: 0.6 };
      return { opacity: picking ? 0.5 : 0.3 };
    },
    [ownedSet, ownedById, overlays, sightedBy, colorOf, state.me.playerId, target, incomingSet, picking, frontierSet, allySet, borderSet],
  );

  const totals = state.owned.reduce(
    (a, o) => ({ pop: a.pop + o.popWorkers + o.popSoldiers + o.popOccupiers, food: a.food + o.food, wood: a.wood + o.wood, stone: a.stone + o.stone }),
    { pop: 0, food: 0, wood: 0, stone: 0 },
  );

  return (
    <div className="age-screen flex h-[calc(100dvh-3rem)] flex-col bg-slate-950" style={ageVars(state.me.age) as React.CSSProperties} data-age={state.me.age}>
      {!phone && <TopMenu matchId={matchId} state={state} selectedRegionId={selected} colorOf={colorOf} overlays={overlays} onToggleOverlay={toggleOverlay} onSelectRegion={goToRegion} clockOffsetMs={clockOffsetMs} />}
      {!state.observer && <RealmTakenPopup messages={menu.messages} onSelectRegion={goToRegion} />}
      {battleId && (
        <BattleWindow
          matchId={matchId}
          battleId={battleId}
          myPlayerId={state.me.playerId}
          onClose={() => setBattleId(null)}
          onSelectRegion={(id) => {
            setBattleId(null);
            goToRegion(id);
          }}
        />
      )}
      {phone && (
        <div className="age-bar flex h-10 shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-950/90 px-2">
          {state.observer ? <span className="inline-flex h-7 shrink-0 items-center rounded-md border border-violet-400/50 bg-violet-500/10 px-2 text-xs font-medium text-violet-100">Admin</span> : <AgeChip age={state.me.age} compact />}
          <ObjectiveChip state={state} compact onOpen={() => setStack([{ kind: "map" }, { kind: "panel", id: "players" }])} />
          <div className="min-w-0 flex-1">
            {menu.toast ? (
              <div className="flex min-w-0 items-center gap-2">
                <button className="min-w-0 flex-1 truncate text-left text-sm text-slate-100" onClick={() => setStack([{ kind: "map" }, { kind: "panel", id: "messages" }])}>
                  {messageIcon(menu.toast.kind)} {menu.toast.subject}
                </button>
                {menu.toast.regionId && (
                  <button
                    className="shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200"
                    onClick={() => {
                      goToRegion(menu.toast!.regionId!);
                      menu.clearToast();
                    }}
                  >
                    Open region →
                  </button>
                )}
              </div>
            ) : menu.chatToast ? (
              <button className="block w-full truncate text-left text-sm text-slate-100" onClick={() => setStack([{ kind: "map" }, { kind: "panel", id: "chat" }])}>
                💬 <span className="text-sky-200">{menu.chatToast.playerName}:</span> {menu.chatToast.body}
              </button>
            ) : (
              <Ticker matchId={matchId} nudge={state.match.now} onSelectRegion={goToRegion} />
            )}
          </div>
          <span className="shrink-0 text-xs text-slate-400">day {Math.min(balance.match.lengthDays, Math.floor(matchDay) + 1)}</span>
        </div>
      )}
      {finished && night && state.match.finishedAt && (
        <MatchNight
          finishedAt={state.match.finishedAt}
          matchName={state.match.name}
          winnerName={state.players.find((p) => p.id === state.match.winnerPlayerId)?.name ?? null}
          onReport={() => {
            leaveNight();
            setSummaryOpen(true);
          }}
        />
      )}
      {finished && <MatchSummary matchId={matchId} open={summaryOpen && !night} onClose={() => setSummaryOpen(false)} colorOf={colorOf} />}
      {!finished && <MatchIntro open={introOpen} onClose={() => setIntroOpen(false)} matchName={state.match.name} speed={state.match.speed} resourceMult={state.match.resourceMult} />}
      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="relative h-full w-full lg:flex-1">
        <WorldMap
          paint={paint}
          selected={selected}
          onSelect={onMapSelect}
          focus={state.me.capitalRegionId}
          flyTo={flyTo}
          className={`h-full w-full ${picking ? "cursor-crosshair" : ""}`}
          ice={ice}
          flags={state.me.capitalRegionId ? [state.me.capitalRegionId] : []}
          dashed={state.frontier}
          armies={markers}
          roads={roadLinks}
          badges={badges}
          onBadgeClick={(b) => b.battleId && setBattleId(b.battleId)}
          storms={state.storms}
          thaws={state.thaws}
        />
        {picking && (
          <div className="pointer-events-none absolute inset-x-0 top-14 flex items-center justify-center gap-3 text-sm text-amber-300 lg:top-2">
            <span className="rounded bg-slate-950/80 px-3 py-1">Tap a region to target it</span>
            {phone && (
              <button className="pointer-events-auto rounded border border-slate-600 bg-slate-950/90 px-3 py-1 text-slate-200" onClick={cancelPick}>
                Cancel
              </button>
            )}
          </div>
        )}
        <div className="pointer-events-none absolute bottom-2 left-2 hidden flex-wrap gap-2 text-xs lg:flex">
          <Badge>{state.match.name}</Badge>
          <Badge>{state.match.speed}x</Badge>
          {state.match.pausedAt && <Badge>paused</Badge>}
          <Badge>{finished ? "finished" : `Day ${Math.min(balance.match.lengthDays, Math.floor(matchDay) + 1)} of ${balance.match.lengthDays} · ends in ${formatCountdown(endsIn)}`}</Badge>
          <Badge>{state.owned.length} regions · {fmt(totals.pop)} people</Badge>
          <Badge accent>{ageTheme(state.me.age).emblem} {ageName(state.me.age)} Age</Badge>
          <Badge>ice beyond {ice.latitude.toFixed(0)}°</Badge>
          <Badge muted={rtStatus !== "open"}>{rtStatus === "open" ? "live" : rtStatus === "closed" ? "reconnecting…" : "connecting…"}</Badge>
        </div>
        <div className="absolute right-2 top-2 flex gap-2 text-xs">
          <button onClick={() => setIntroOpen(true)} className="rounded bg-slate-950/80 px-3 py-2 text-slate-200 hover:bg-slate-800 lg:px-2 lg:py-1" aria-label="How to play" title="How to play">
            ?
          </button>
          <button onClick={() => setForecast((f) => !f)} className={`rounded px-3 py-2 lg:px-2 lg:py-1 ${forecast ? "bg-sky-200 text-slate-900" : "bg-slate-950/80 text-slate-200 hover:bg-slate-800"}`}>
            Ice forecast
          </button>
        </div>
        {phone && (
          <PhoneShell
            matchId={matchId}
            state={state}
            screen={screen}
            push={push}
            pop={pop}
            openRegion={goToRegion}
            setRegionTab={setRegionTab}
            clockOffsetMs={clockOffsetMs}
            colorOf={colorOf}
            overlays={overlays}
            onToggleOverlay={toggleOverlay}
            target={target}
            onPickTarget={onPickTarget}
            onClearTarget={() => setTarget(null)}
            finished={finished}
            eliminated={eliminated}
            onOpenSummary={() => setSummaryOpen(true)}
            menu={menu}
          />
        )}
      </div>
      {!phone && (
      <BottomSheet
        stop={sheet}
        onStop={setSheet}
        summary={
          <span>
            {selected ? <b className="text-slate-100">{regionById(selected)?.name ?? selected}</b> : "No region selected"}
            <span className="text-slate-500"> · day {Math.min(balance.match.lengthDays, Math.floor(matchDay) + 1)} · {state.match.speed}x · {state.owned.length} regions</span>
          </span>
        }
      >
        {finished && (
          <Card className="border-amber-500/40 bg-amber-500/10 text-sm text-amber-100">
            The match is over.{" "}
            <button className="underline" onClick={() => setSummaryOpen(true)}>
              Open the final report
            </button>{" "}
            or{" "}
            <Link to="/match/$matchId/leaderboard" params={{ matchId }} className="underline">
              see the standings
            </Link>
            .
          </Card>
        )}
        {eliminated && <Card className="border-slate-600 text-sm text-slate-300">You have no regions left. You can keep watching the match and chat; join the next match from the lobby.</Card>}
        <IncomingWarnings state={state} clockOffsetMs={clockOffsetMs} onSelect={setSelected} />
        <RefugeePanel matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} onSelect={setSelected} />
        <ActivityPanel matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} onSelect={setSelected} />
        {selected && state.battles.some((b) => b.regionId === selected) && (
          <button className="w-full rounded-md border border-rose-500/50 bg-rose-500/15 px-3 py-2 text-sm font-medium text-rose-100 hover:bg-rose-500/25" onClick={() => setBattleId(state.battles.find((b) => b.regionId === selected)!.id)}>
            ⚔ A battle is on here: watch it
          </button>
        )}
        {selected ? (
          <RegionPanel matchId={matchId} state={state} regionId={selected} clockOffsetMs={clockOffsetMs} onClose={() => setSelected(null)} target={target} onPickTarget={onPickTarget} onClearTarget={() => setTarget(null)} />
        ) : (
          <Card>
            <p className="text-sm text-slate-400">Tap a region to see it. Your regions are in your colour, the flag marks your capital, and dashed outlines are unclaimed land you can settle.</p>
          </Card>
        )}
        <TradeRoutesPanel matchId={matchId} state={state} selectedRegionId={selected} clockOffsetMs={clockOffsetMs} />
        <ResearchPanel matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} />
        <DevTools matchId={matchId} />
      </BottomSheet>
      )}
      </div>
      {phone && (
        <PhoneTabBar
          active={tabOf(screen)}
          onChange={onTab}
          badges={{ map: state.incoming.length + state.refugees.length || undefined, more: menu.alerts || undefined, region: selected && state.jobs.some((j) => j.regionId === selected && j.waitingFor) ? "!" : undefined }}
          disabled={{ region: !selected && !state.me.capitalRegionId }}
        />
      )}
    </div>
  );
}

function Badge({ children, muted, accent }: { children: React.ReactNode; muted?: boolean; accent?: boolean }) {
  return (
    <span className={`rounded border border-transparent bg-slate-950/80 px-2 py-1 ${muted ? "text-amber-300" : "text-slate-200"}`} style={accent ? { borderColor: "var(--age-accent)", background: "var(--age-soft)", color: "var(--age-text)" } : undefined}>
      {children}
    </span>
  );
}

/** "Start now" is for admins and dev servers; time skips only exist when the server runs with DEV_TOOLS=true. */
function DevTools({ matchId, lobby, onStart }: { matchId: string; lobby?: boolean; onStart?: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const info = useServerInfo();
  const skip = useMutation({
    mutationFn: (seconds: number) => api.devTimeSkip(matchId, seconds),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  const dev = !!info.data?.devTools;
  const admin = !!me.data?.isAdmin;
  if (!dev && !admin) return null;
  if (!dev && !lobby) return null;
  return (
    <Card className="border-dashed">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">{dev ? "Dev tools" : "Admin"}</h2>
      <div className="flex flex-wrap gap-2">
        {lobby && onStart && (
          <Button variant="ghost" onClick={onStart}>
            Start now
          </Button>
        )}
        {!lobby && dev && (
          <>
            <Button variant="ghost" onClick={() => skip.mutate(3600)}>
              +1h
            </Button>
            <Button variant="ghost" onClick={() => skip.mutate(6 * 3600)}>
              +6h
            </Button>
            <Button variant="ghost" onClick={() => skip.mutate(24 * 3600)}>
              +1d
            </Button>
          </>
        )}
      </div>
      <ErrorText>{skip.error?.message}</ErrorText>
    </Card>
  );
}
