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

export function costText(cost: Record<string, number | undefined>): string {
  return Object.entries(cost)
    .filter(([, v]) => v)
    .map(([k, v]) => `${v} ${k.replace("_", " ")}`)
    .join(", ");
}
