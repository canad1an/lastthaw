import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { formatCountdown, regionById, type MapRegion, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { useMatchRealtime } from "../api/realtime.js";
import { RegionPanel, ageName } from "../components/RegionPanel.js";
import { ResearchPanel } from "../components/ResearchPanel.js";
import { Messages } from "../components/Messages.js";
import { Button, Card, ErrorText, fmt } from "../components/ui.js";
import { useNow } from "../hooks/useNow.js";
import { WorldMap, terrainFill, type RegionPaint } from "../map/WorldMap.js";

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
  const clockOffsetMs = Date.parse(state.match.now) - Date.now();
  const endsIn = (Date.parse(state.match.endsAt) - (now + clockOffsetMs)) / 1000;

  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    state.players.forEach((p, i) => m.set(p.id, PLAYER_COLORS[i % PLAYER_COLORS.length]!));
    return (id: string) => m.get(id) ?? "#999";
  }, [state.players]);
  const ownedSet = useMemo(() => new Set(state.owned.map((o) => o.regionId)), [state.owned]);
  const sightedBy = useMemo(() => new Map(state.sighted.map((s) => [s.regionId, s])), [state.sighted]);

  const paint = useCallback(
    (r: MapRegion): RegionPaint => {
      if (ownedSet.has(r.id)) return { fill: colorOf(state.me.playerId), opacity: 1 };
      const s = sightedBy.get(r.id);
      if (s) return { fill: s.ownerPlayerId ? colorOf(s.ownerPlayerId) : terrainFill(r.terrain), opacity: 0.8 };
      return { opacity: 0.3 };
    },
    [ownedSet, sightedBy, colorOf, state.me.playerId],
  );

  const totals = state.owned.reduce(
    (a, o) => ({ pop: a.pop + o.popWorkers + o.popSoldiers + o.popOccupiers, food: a.food + o.food, wood: a.wood + o.wood, stone: a.stone + o.stone }),
    { pop: 0, food: 0, wood: 0, stone: 0 },
  );

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col lg:flex-row">
      <div className="relative h-1/2 w-full lg:h-full lg:flex-1">
        <WorldMap paint={paint} selected={selected} onSelect={setSelected} focus={state.me.capitalRegionId} className="h-full w-full" />
        <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-2 text-xs">
          <Badge>{state.match.name}</Badge>
          <Badge>{state.match.speed}x</Badge>
          <Badge>ends in {formatCountdown(endsIn)}</Badge>
          <Badge>{state.owned.length} regions · {fmt(totals.pop)} people</Badge>
          <Badge>{ageName(state.me.age)} Age</Badge>
          <Badge muted={rtStatus !== "open"}>live {rtStatus}</Badge>
        </div>
      </div>
      <aside className="w-full space-y-3 overflow-y-auto border-t border-slate-800 p-4 lg:w-96 lg:border-l lg:border-t-0">
        {selected ? (
          <RegionPanel matchId={matchId} state={state} regionId={selected} clockOffsetMs={clockOffsetMs} onClose={() => setSelected(null)} />
        ) : (
          <Card>
            <p className="text-sm text-slate-400">Tap a region to see it. Your regions are highlighted in your colour.</p>
          </Card>
        )}
        <Messages matchId={matchId} />
        <ResearchPanel matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} />
        <Card>
          <h2 className="mb-2 text-sm font-medium">Players</h2>
          <ul className="space-y-1 text-sm">
            {[...state.players]
              .sort((a, b) => b.regions - a.regions)
              .map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-slate-300">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorOf(p.id) }} />
                  <span className={p.id === state.me.playerId ? "text-white" : ""}>{p.name}</span>
                  <span className="text-xs text-slate-500">{ageName(p.age)}</span>
                  <span className="ml-auto text-slate-500">{p.regions} regions</span>
                </li>
              ))}
          </ul>
        </Card>
        <DevTools matchId={matchId} />
      </aside>
    </div>
  );
}

function Badge({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <span className={`rounded bg-slate-950/80 px-2 py-1 ${muted ? "text-amber-300" : "text-slate-200"}`}>{children}</span>;
}

/** Only works when the server runs with DEV_TOOLS=true; otherwise the buttons just error. */
function DevTools({ matchId, lobby, onStart }: { matchId: string; lobby?: boolean; onStart?: () => void }) {
  const qc = useQueryClient();
  const skip = useMutation({
    mutationFn: (seconds: number) => api.devTimeSkip(matchId, seconds),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  return (
    <Card className="border-dashed">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Dev tools</h2>
      <div className="flex flex-wrap gap-2">
        {lobby && onStart && (
          <Button variant="ghost" onClick={onStart}>
            Start now
          </Button>
        )}
        {!lobby && (
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
