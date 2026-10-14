import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { AGES, availableTechs, balance, canAfford, formatCountdown, realSeconds, techById, techSeconds, type MatchStateView, type TechDef, techCost, matchDayOf } from "@lastthaw/shared";
import { Tooltip } from "./Tooltip.js";
import { techPreview } from "./previews.js";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText } from "./ui.js";
import { Countdown, CostLine } from "./Countdown.js";
import { useLiveEconomy } from "./RegionPanel.js";

/** Research panel: a queue of up to N techs, one researching at a time, paid from the capital. */
export function ResearchPanel({ matchId, state, clockOffsetMs }: { matchId: string; state: MatchStateView; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const queued = useMemo(() => state.jobs.filter((j) => j.kind === "research").sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt)), [state.jobs]);
  // Prerequisites count as met when the tech is already in the queue.
  const known = useMemo(() => new Set([...state.me.techs, ...queued.map((j) => j.refId ?? "")]), [state.me.techs, queued]);
  const capital = state.owned.find((o) => o.isCapital) ?? state.owned[0] ?? null;
  const m = useMutation({ mutationFn: (techId: string) => api.research(matchId, techId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  const cancel = useMutation({ mutationFn: (jobId: string) => api.cancelJob(matchId, jobId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  const list = availableTechs(state.me.age, known);
  const full = queued.length >= balance.queue.researchSlots;

  return (
    <Card className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Research</h2>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">{AGES[state.me.age as 0 | 1 | 2 | 3 | 4]} Age</span>
      </div>
      {queued.length > 0 && (
        <ul className="space-y-1">
          {queued.map((j, i) => (
            <li key={j.id} className="flex items-center justify-between rounded bg-slate-800/60 px-2 py-1 text-sm">
              <span>
                {techById.get(j.refId ?? "")?.name ?? j.refId}
                {i > 0 && <span className="ml-1 text-xs text-slate-500">queued</span>}
              </span>
              <span className="text-slate-400">
                <Countdown to={j.endsAt} clockOffsetMs={clockOffsetMs} />
              </span>
              <button className="text-xs text-slate-500 hover:text-rose-400" onClick={() => cancel.mutate(j.id)} title="Cancel">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {full && <p className="text-xs text-amber-300">Research queue full ({balance.queue.researchSlots}).</p>}
      <ErrorText>{m.error?.message}</ErrorText>
      {capital ? (
        <TechList state={state} clockOffsetMs={clockOffsetMs} list={list} busy={full || m.isPending} capital={capital} onPick={(id) => m.mutate(id)} />
      ) : (
        <p className="text-xs text-slate-400">Research is paid from all your regions: food, wood and stone from the capital first, ore and horses from wherever you have them.</p>
      )}
    </Card>
  );
}

function TechTip({ def }: { def: TechDef }) {
  const { summary, unlocks } = techPreview(def);
  return (
    <div>
      <p className="text-slate-200">{summary}</p>
      {unlocks.length ? (
        <>
          <p className="mt-2 text-[10px] uppercase tracking-wide text-slate-500">Unlocks</p>
          <ul className="list-disc pl-4 text-slate-300">
            {unlocks.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-slate-400">A stepping stone: other techs need it.</p>
      )}
      {def.requires?.length ? <p className="mt-2 text-slate-500">Needs {def.requires.map((r) => techById.get(r)?.name ?? r).join(", ")}.</p> : null}
    </div>
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
  state: MatchStateView;
  clockOffsetMs: number;
  list: ReturnType<typeof availableTechs>;
  busy: boolean;
  capital: MatchStateView["owned"][number];
  onPick: (id: string) => void;
}) {
  const live = useLiveEconomy(capital, clockOffsetMs, state.match.speed);
  // Research draws ore and horses from every region, so show the pooled special stock.
  const pooledSpecial: Record<string, number> = {};
  for (const o of state.owned) if (!o.frozen) for (const [k, v] of Object.entries(o.special)) pooledSpecial[k] = (pooledSpecial[k] ?? 0) + v;
  const stock = { food: live.e.food, wood: live.e.wood, stone: live.e.stone, ...live.e.special, ...pooledSpecial };
  if (list.length === 0) return <p className="text-xs text-slate-400">Nothing left to research in this age.</p>;
  return (
    <ul className="divide-y divide-slate-800">
      {list.map((t) => {
        const cost = techCost(t, matchDayOf(state, clockOffsetMs));
        const ok = !busy && canAfford(stock, cost);
        const secs = realSeconds(techSeconds(t), capital.effects.researchSpeed, state.match.speed);
        return (
          <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
            <Tooltip
              className="min-w-0 flex-1 cursor-help"
              trigger={
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    {t.advancesTo !== undefined && <span className="rounded bg-amber-500/20 px-1 text-xs text-amber-300">→ {AGES[t.advancesTo]} Age</span>}
                    <span className="text-xs text-slate-600">ⓘ</span>
                  </div>
                  <p className="truncate text-xs text-slate-400">{t.description}</p>
                  <p>
                    <CostLine cost={cost} stock={stock} suffix={formatCountdown(secs)} />
                  </p>
                </div>
              }
            >
              <TechTip def={t} />
            </Tooltip>
            <Button variant="ghost" disabled={!ok} onClick={() => onPick(t.id)}>
              Research
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
