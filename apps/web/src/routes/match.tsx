import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { balance, formatCountdown, iceLatitudeOnDay, regionById, type MapRegion, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { useMatchRealtime } from "../api/realtime.js";
import { RegionPanel, ageName } from "../components/RegionPanel.js";
import { ResearchPanel } from "../components/ResearchPanel.js";
import { TopMenu } from "../components/TopMenu.js";
import { IncomingWarnings } from "../components/ArmyPanel.js";
import { ActivityPanel } from "../components/ActivityPanel.js";
import { TradeRoutesPanel } from "../components/TradeRoutesPanel.js";
import { Button, Card, ErrorText, fmt } from "../components/ui.js";
import { useNow } from "../hooks/useNow.js";
import { useServerInfo } from "../hooks/useServerInfo.js";
import { useMe } from "../api/auth.js";
import { WorldMap, terrainFill, type RegionPaint } from "../map/WorldMap.js";
import { armyMarkers } from "../map/armyMarkers.js";

const PLAYER_COLORS = ["#38bdf8", "#f472b6", "#a3e635", "#fb923c", "#c084fc", "#2dd4bf", "#facc15", "#f87171"];

export function MatchPage() {
  const { matchId } = useParams({ from: "/match/$matchId" });
  const state = useQuery({ queryKey: keys.matchState(matchId), queryFn: () => api.matchState(matchId), refetchInterval: 30_000 });
  const rt = useMatchRealtime(matchId);

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
  if (s.match.status === "lobby") return <LobbyView matchId={matchId} state={s} />;
  return <GameView matchId={matchId} state={s} rtStatus={rt.status} />;
}

/** Before the match starts: pick a capital from the offered options. */
function LobbyView({ matchId, state }: { matchId: string; state: MatchStateView }) {
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
    <div className="flex h-[calc(100dvh-3rem)] flex-col lg:flex-row">
      <WorldMap paint={paint} selected={selected} onSelect={setSelected} focus={current ?? options.data?.options[0] ?? null} className="h-1/2 w-full lg:h-full lg:flex-1" />
      <aside className="w-full space-y-3 overflow-y-auto border-t border-slate-800 p-4 lg:w-96 lg:border-l lg:border-t-0">
        <h1 className="text-xl font-semibold">{state.match.name}</h1>
        <p className="text-sm text-slate-400">
          {state.players.length} players · {state.match.speed}x · {startsIn > 0 ? `starts in ${formatCountdown(startsIn)}` : "starting..."}
        </p>
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
        <Card>
          <h2 className="mb-2 text-sm font-medium">Players</h2>
          <ul className="space-y-1 text-sm text-slate-300">
            {state.players.map((p) => (
              <li key={p.id}>{p.name}</li>
            ))}
          </ul>
        </Card>
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
  const onMapSelect = useCallback(
    (id: string | null) => {
      if (picking && id) {
        setTarget(id);
        setPicking(false);
      } else {
        setSelected(id);
      }
    },
    [picking],
  );
  // Server-time offset, captured once per state fetch. Recomputing it every render
  // would pin countdowns to the moment the snapshot was taken.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clockOffsetMs = useMemo(() => Date.parse(state.match.now) - Date.now(), [state.match.now]);
  const endsIn = (Date.parse(state.match.endsAt) - (now + clockOffsetMs)) / 1000;
  const [forecast, setForecast] = useState(false);
  const matchDay = Math.min(balance.match.lengthDays, Math.max(0, ((now + clockOffsetMs - Date.parse(state.match.startsAt)) / 86400_000) * state.match.speed));
  const ice = useMemo(() => ({ latitude: iceLatitudeOnDay(matchDay), forecast, day: matchDay }), [matchDay, forecast]);
  const markers = useMemo(() => armyMarkers(state.armies, state.incoming, now + clockOffsetMs, formatCountdown, state.me.techs), [state.armies, state.incoming, now, clockOffsetMs]);
  const finished = state.match.status === "finished";
  const eliminated = state.owned.length === 0 && !finished;

  // Colours follow join order (the server returns players in that order) and never change during a match.
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    state.players.forEach((p, i) => m.set(p.id, PLAYER_COLORS[i % PLAYER_COLORS.length]!));
    return (id: string) => m.get(id) ?? "#999";
  }, [state.players]);
  const ownedSet = useMemo(() => new Set(state.owned.map((o) => o.regionId)), [state.owned]);
  const sightedBy = useMemo(() => new Map(state.sighted.map((s) => [s.regionId, s])), [state.sighted]);

  const incomingSet = useMemo(() => new Set(state.incoming.map((i) => i.targetRegionId)), [state.incoming]);
  // Road links: between adjacent regions that both have Roads, among mine and what I can see.
  const roadLinks = useMemo(() => {
    const colour = new Map<string, string>();
    for (const o of state.owned) if ((o.buildings.roads ?? 0) >= 1 && !o.frozen) colour.set(o.regionId, colorOf(state.me.playerId));
    for (const s of state.sighted) if (s.roads && !colour.has(s.regionId)) colour.set(s.regionId, "#cbd5e1");
    const out: Array<[string, string, string]> = [];
    for (const [id, c] of colour) {
      for (const n of regionById(id)?.neighbors ?? []) {
        if (id < n && colour.has(n)) out.push([id, n, c === colour.get(n) ? c : "#cbd5e1"]);
      }
    }
    return out;
  }, [state.owned, state.sighted, state.me.playerId, colorOf]);
  const frontierSet = useMemo(() => new Set(state.frontier), [state.frontier]);
  const paint = useCallback(
    (r: MapRegion): RegionPaint => {
      if (r.id === target) return { fill: "#facc15", opacity: 1, stroke: "#fff" };
      if (ownedSet.has(r.id)) return { fill: colorOf(state.me.playerId), opacity: 1, ...(incomingSet.has(r.id) ? { stroke: "#f43f5e" } : {}) };
      const s = sightedBy.get(r.id);
      if (s) return { fill: s.ownerPlayerId ? colorOf(s.ownerPlayerId) : terrainFill(r.terrain), opacity: 0.8 };
      if (frontierSet.has(r.id)) return { opacity: 0.6 };
      return { opacity: picking ? 0.5 : 0.3 };
    },
    [ownedSet, sightedBy, colorOf, state.me.playerId, target, incomingSet, picking, frontierSet],
  );

  const totals = state.owned.reduce(
    (a, o) => ({ pop: a.pop + o.popWorkers + o.popSoldiers + o.popOccupiers, food: a.food + o.food, wood: a.wood + o.wood, stone: a.stone + o.stone }),
    { pop: 0, food: 0, wood: 0, stone: 0 },
  );

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <TopMenu matchId={matchId} state={state} selectedRegionId={selected} colorOf={colorOf} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="relative h-1/2 w-full lg:h-full lg:flex-1">
        <WorldMap
          paint={paint}
          selected={selected}
          onSelect={onMapSelect}
          focus={state.me.capitalRegionId}
          className={`h-full w-full ${picking ? "cursor-crosshair" : ""}`}
          ice={ice}
          flags={state.me.capitalRegionId ? [state.me.capitalRegionId] : []}
          dashed={state.frontier}
          armies={markers}
          roads={roadLinks}
        />
        {picking && <div className="pointer-events-none absolute inset-x-0 top-2 text-center text-sm text-amber-300">Click a region to target it</div>}
        <div className="pointer-events-none absolute bottom-2 left-2 hidden flex-wrap gap-2 text-xs lg:flex">
          <Badge>{state.match.name}</Badge>
          <Badge>{state.match.speed}x</Badge>
          <Badge>{finished ? "finished" : `Day ${Math.min(balance.match.lengthDays, Math.floor(matchDay) + 1)} of ${balance.match.lengthDays} · ends in ${formatCountdown(endsIn)}`}</Badge>
          <Badge>{state.owned.length} regions · {fmt(totals.pop)} people</Badge>
          <Badge>{ageName(state.me.age)} Age</Badge>
          <Badge>ice beyond {ice.latitude.toFixed(0)}°</Badge>
          <Badge muted={rtStatus !== "open"}>{rtStatus === "open" ? "live" : rtStatus === "closed" ? "reconnecting…" : "connecting…"}</Badge>
        </div>
        <div className="absolute right-2 top-2 flex gap-2 text-xs">
          <button onClick={() => setForecast((f) => !f)} className={`rounded px-2 py-1 ${forecast ? "bg-sky-200 text-slate-900" : "bg-slate-950/80 text-slate-200 hover:bg-slate-800"}`}>
            Ice forecast
          </button>
        </div>
      </div>
      <aside className="w-full space-y-3 overflow-y-auto border-t border-slate-800 p-4 lg:w-96 lg:border-l lg:border-t-0">
        {finished && (
          <Card className="border-amber-500/40 bg-amber-500/10 text-sm text-amber-100">
            The match is over.{" "}
            <Link to="/match/$matchId/leaderboard" params={{ matchId }} className="underline">
              See the final standings
            </Link>
            .
          </Card>
        )}
        {eliminated && <Card className="border-slate-600 text-sm text-slate-300">You have no regions left. You can keep watching the match and chat; join the next match from the lobby.</Card>}
        <IncomingWarnings state={state} clockOffsetMs={clockOffsetMs} onSelect={setSelected} />
        <ActivityPanel matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} onSelect={setSelected} />
        {selected ? (
          <RegionPanel matchId={matchId} state={state} regionId={selected} clockOffsetMs={clockOffsetMs} onClose={() => setSelected(null)} target={target} onPickTarget={setPicking} />
        ) : (
          <Card>
            <p className="text-sm text-slate-400">Tap a region to see it. Your regions are in your colour, the flag marks your capital, and dashed outlines are unclaimed land you can settle.</p>
          </Card>
        )}
        <TradeRoutesPanel matchId={matchId} state={state} selectedRegionId={selected} clockOffsetMs={clockOffsetMs} />
        <ResearchPanel matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} />
        <DevTools matchId={matchId} />
      </aside>
      </div>
    </div>
  );
}

function Badge({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <span className={`rounded bg-slate-950/80 px-2 py-1 ${muted ? "text-amber-300" : "text-slate-200"}`}>{children}</span>;
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
