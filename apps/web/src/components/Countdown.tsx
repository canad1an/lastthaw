import { formatCountdown } from "@lastthaw/shared";
import { useNow } from "../hooks/useNow.js";

/** Live countdown to an ISO instant, measured on the match clock. */
export function Countdown({ to, clockOffsetMs, prefix = "" }: { to: string; clockOffsetMs: number; prefix?: string }) {
  const now = useNow(1000);
  const s = (Date.parse(to) - (now + clockOffsetMs)) / 1000;
  return (
    <span className="tabular-nums">
      {prefix}
      {s <= 0 ? "done" : formatCountdown(s)}
    </span>
  );
}

/** Cost list where only the resources you lack are red. */
export function CostLine({ cost, stock, suffix }: { cost: Record<string, number | undefined>; stock: Record<string, number>; suffix?: string }) {
  const parts = Object.entries(cost).filter(([, v]) => v);
  return (
    <span className="text-xs">
      {parts.map(([k, v], i) => (
        <span key={k} className={(stock[k] ?? 0) >= (v ?? 0) ? "text-slate-400" : "text-rose-400"}>
          {i > 0 ? ", " : ""}
          {v} {k.replace("_", " ")}
        </span>
      ))}
      {suffix && <span className="text-slate-400"> · {suffix}</span>}
    </span>
  );
}

export function costText(cost: Record<string, number | undefined>): string {
  return Object.entries(cost)
    .filter(([, v]) => v)
    .map(([k, v]) => `${v} ${k.replace("_", " ")}`)
    .join(", ");
}

/**
 * Time for a queued job: the one that is running counts down; the ones behind
 * it wait, showing how long they will take once their turn comes.
 */
export function JobTime({ startsAt, endsAt, clockOffsetMs }: { startsAt: string; endsAt: string; clockOffsetMs: number }) {
  const now = useNow(1000);
  const t = now + clockOffsetMs;
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (t < start) {
    return (
      <span className="tabular-nums text-slate-500" title={`Starts in ${formatCountdown((start - t) / 1000)}`}>
        waiting · {formatCountdown((end - start) / 1000)}
      </span>
    );
  }
  return <span className="tabular-nums">{end - t <= 0 ? "done" : formatCountdown((end - t) / 1000)}</span>;
}
