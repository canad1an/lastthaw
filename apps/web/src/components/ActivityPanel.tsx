import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { buildingById, regionById, techById, unitById, type MatchStateView, missionLabel } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Card } from "./ui.js";
import { Countdown } from "./Countdown.js";

/**
 * Everything in progress, always visible at the top of the side panel:
 * builds and trainings per region, the research queue, and armies in flight.
 */
export function ActivityPanel({ matchId, state, clockOffsetMs, onSelect }: { matchId: string; state: MatchStateView; clockOffsetMs: number; onSelect: (regionId: string) => void }) {
  const qc = useQueryClient();
  const cancel = useMutation({ mutationFn: (jobId: string) => api.cancelJob(matchId, jobId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  const recall = useMutation({ mutationFn: (armyId: string) => api.recallArmy(matchId, armyId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }) });
  const now = Date.now() + clockOffsetMs;
  const jobs = [...state.jobs].sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
  const research = jobs.filter((j) => j.kind === "research");
  const work = jobs.filter((j) => j.kind === "build" || j.kind === "train");
  const armies = state.armies;
  const total = research.length + work.length + armies.length;

  const label = (j: MatchStateView["jobs"][number]) =>
    j.kind === "build"
      ? `${buildingById.get(j.refId ?? "")?.name ?? j.refId} lvl ${j.level}`
      : j.kind === "train"
        ? `${j.qty} ${unitById.get(j.refId ?? "")?.name ?? j.refId}`
        : (techById.get(j.refId ?? "")?.name ?? j.refId ?? "");

  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("lt_inprogress_open") !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem("lt_inprogress_open", o ? "0" : "1");
      } catch {
        // ignore
      }
      return !o;
    });
  };
  // Collapsed: just the header with the count and the soonest completion.
  const next = [...research, ...work].sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))[0];

  return (
    <Card className="space-y-1 border-sky-500/30">
      <button type="button" onClick={toggle} className="flex w-full items-center justify-between text-left" aria-expanded={open}>
        <h2 className="text-sm font-medium">
          <span className="mr-1 inline-block w-3 text-slate-500">{open ? "▾" : "▸"}</span>In progress
        </h2>
        <span className="flex items-center gap-2 text-xs text-slate-300">
          {!open && next && (
            <span className="text-slate-400">
              next: {label(next)} <Countdown to={next.endsAt} clockOffsetMs={clockOffsetMs} />
            </span>
          )}
          <span className="rounded bg-slate-800 px-1.5 py-0.5">{total}</span>
        </span>
      </button>
      {!open ? null : (
        <>
      {total === 0 && <p className="text-xs text-slate-400">Nothing is building, training or researching. Pick a region to start something.</p>}
      {research.length > 0 && (
        <Section title="Research">
          {research.map((j, i) => (
            <Row key={j.id} name={label(j)} note={i > 0 ? "queued" : ""} to={j.endsAt} clockOffsetMs={clockOffsetMs} waiting={Date.parse(j.startsAt) > now} onCancel={() => cancel.mutate(j.id)} />
          ))}
        </Section>
      )}
      {work.length > 0 && (
        <Section title="Building and training">
          {work.map((j) => (
            <Row
              key={j.id}
              name={label(j)}
              note={regionById(j.regionId ?? "")?.name ?? ""}
              to={j.endsAt}
              clockOffsetMs={clockOffsetMs}
              waiting={Date.parse(j.startsAt) > now}
              onCancel={() => cancel.mutate(j.id)}
              onClick={j.regionId ? () => onSelect(j.regionId!) : undefined}
            />
          ))}
        </Section>
      )}
      {armies.length > 0 && (
        <Section title="On the move">
          {armies.map((a) => (
            <Row
              key={a.id}
              name={`${missionLabel(a.mission)} ${a.status === "returning" ? "returning to" : "→"} ${regionById(a.status === "returning" ? a.originRegionId : a.targetRegionId)?.name}${a.status === "returning" && a.note ? ` (${a.note})` : ""}`}
              note={`${Object.values(a.units).reduce((x, y) => x + y, 0)} units`}
              to={a.status === "returning" ? (a.returnsAt ?? a.arrivesAt) : a.arrivesAt}
              clockOffsetMs={clockOffsetMs}
              onClick={() => onSelect(a.targetRegionId)}
              onCancel={a.status === "outbound" ? () => recall.mutate(a.id) : undefined}
              cancelTitle="Recall: turn around and come home"
            />
          ))}
        </Section>
      )}
        </>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-slate-500">{title}</p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function Row({ name, note, to, clockOffsetMs, waiting, onCancel, onClick, cancelTitle = "Cancel" }: { name: string; note: string; to: string; clockOffsetMs: number; waiting?: boolean | undefined; onCancel?: (() => void) | undefined; onClick?: (() => void) | undefined; cancelTitle?: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <button className={`min-w-0 flex-1 truncate text-left ${onClick ? "hover:text-white" : "cursor-default"}`} onClick={onClick}>
        {name}
        {note && <span className="ml-1 text-xs text-slate-500">{note}</span>}
      </button>
      <span className={`tabular-nums ${waiting ? "text-slate-500" : "text-sky-300"}`}>
        <Countdown to={to} clockOffsetMs={clockOffsetMs} />
      </span>
      {onCancel && (
        <button className="text-xs text-slate-600 hover:text-rose-400" onClick={onCancel} title={cancelTitle}>
          {cancelTitle.startsWith("Recall") ? "↩" : "✕"}
        </button>
      )}
    </li>
  );
}
