import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { AGES, availableTechs, canAfford, formatCountdown, realSeconds, techById, techSeconds, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText } from "./ui.js";
import { Countdown, costText } from "./Countdown.js";
import { useLiveEconomy } from "./RegionPanel.js";

export function ResearchPanel({ matchId, state, clockOffsetMs }: { matchId: string; state: MatchStateView; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const techs = useMemo(() => new Set(state.me.techs), [state.me.techs]);
  const current = state.jobs.find((j) => j.kind === "research") ?? null;
  const capital = state.owned.find((o) => o.isCapital) ?? state.owned[0] ?? null;
  const m = useMutation({ mutationFn: (techId: string) => api.research(matchId, techId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  const cancel = useMutation({ mutationFn: (jobId: string) => api.cancelJob(matchId, jobId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  const list = availableTechs(state.me.age, techs);

  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Research</h2>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">{AGES[state.me.age as 0 | 1 | 2 | 3 | 4]} Age</span>
      </div>
      {current && (
        <div className="flex items-center justify-between rounded bg-slate-800/60 px-2 py-1 text-sm">
          <span>{techById.get(current.refId ?? "")?.name ?? current.refId}</span>
          <span className="text-slate-400">
            <Countdown to={current.endsAt} clockOffsetMs={clockOffsetMs} />
          </span>
          <button className="text-xs text-slate-500 hover:text-rose-400" onClick={() => cancel.mutate(current.id)}>
            ✕
          </button>
        </div>
      )}
      <ErrorText>{m.error?.message}</ErrorText>
      {capital ? (
        <TechList matchId={matchId} state={state} clockOffsetMs={clockOffsetMs} list={list} busy={!!current || m.isPending} capital={capital} onPick={(id) => m.mutate(id)} />
      ) : (
        <p className="text-xs text-slate-400">Research is paid from your capital.</p>
      )}
    </Card>
  );
}

function TechList({
  state,
  clockOffsetMs,
  list,
  busy,
  capital,
  onPick,
}: {
  matchId: string;
  state: MatchStateView;
  clockOffsetMs: number;
  list: ReturnType<typeof availableTechs>;
  busy: boolean;
  capital: MatchStateView["owned"][number];
  onPick: (id: string) => void;
}) {
  const live = useLiveEconomy(capital, clockOffsetMs, state.match.speed);
  const stock = { food: live.e.food, wood: live.e.wood, stone: live.e.stone, ...live.e.special };
  if (list.length === 0) return <p className="text-xs text-slate-400">Nothing left to research in this age.</p>;
  return (
    <ul className="divide-y divide-slate-800">
      {list.map((t) => {
        const ok = !busy && canAfford(stock, t.cost);
        const secs = realSeconds(techSeconds(t), capital.effects.researchSpeed, state.match.speed);
        return (
          <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{t.name}</span>
                {t.advancesTo !== undefined && <span className="rounded bg-amber-500/20 px-1 text-xs text-amber-300">→ {AGES[t.advancesTo]} Age</span>}
              </div>
              <p className="truncate text-xs text-slate-400">{t.description}</p>
              <p className={`text-xs ${canAfford(stock, t.cost) ? "text-slate-400" : "text-rose-400"}`}>
                {costText(t.cost)} · {formatCountdown(secs)}
              </p>
            </div>
            <Button variant="ghost" disabled={!ok} onClick={() => onPick(t.id)}>
              Research
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
