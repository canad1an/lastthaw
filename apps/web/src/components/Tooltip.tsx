import { useState, type ReactNode } from "react";

/**
 * Hover tooltip that also works by tap: the trigger toggles it on click so it
 * is usable on phones. Rendered inline below the trigger so it never clips
 * inside the scrolling side bar.
 */
export function Tooltip({ trigger, children, className = "" }: { trigger: ReactNode; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`relative ${className}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-slate-700 bg-slate-950 p-3 text-xs text-slate-300 shadow-xl" onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      )}
    </div>
  );
}

export interface Delta {
  label: string;
  before: string;
  after: string;
  /** "up" is good, "down" is bad, undefined neutral. */
  tone?: "up" | "down";
}

/** Two-column before → after table. */
export function BeforeAfter({ rows, beforeLabel = "now", afterLabel = "after" }: { rows: Delta[]; beforeLabel?: string; afterLabel?: string }) {
  if (rows.length === 0) return null;
  return (
    <table className="mt-2 w-full">
      <thead>
        <tr className="text-[10px] uppercase tracking-wide text-slate-500">
          <th className="text-left font-medium"></th>
          <th className="text-right font-medium">{beforeLabel}</th>
          <th className="text-right font-medium">{afterLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td className="py-0.5 text-slate-400">{r.label}</td>
            <td className="py-0.5 text-right tabular-nums text-slate-300">{r.before}</td>
            <td className={`py-0.5 text-right tabular-nums ${r.tone === "down" ? "text-rose-300" : r.tone === "up" ? "text-emerald-300" : "text-slate-100"}`}>{r.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
