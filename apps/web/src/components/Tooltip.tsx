import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Hover tooltip that also works by tap. It is rendered at the document level
 * with fixed positioning, so it is never clipped by the scrolling side panel,
 * and it flips above the trigger when there is no room below.
 */
export function Tooltip({ trigger, children, className = "" }: { trigger: ReactNode; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const a = anchor.current!.getBoundingClientRect();
      const h = panel.current?.offsetHeight ?? 200;
      const margin = 8;
      const width = Math.min(360, window.innerWidth - 2 * margin);
      const left = Math.min(Math.max(margin, a.left), window.innerWidth - width - margin);
      const below = a.bottom + 4;
      const fits = below + h + margin <= window.innerHeight;
      const top = fits ? below : Math.max(margin, a.top - 4 - h);
      setStyle({ position: "fixed", left, top, width, maxHeight: window.innerHeight - 2 * margin, overflowY: "auto" });
    };
    place();
    window.addEventListener("resize", place);
    // Scrolling the side panel moves the anchor; close rather than chase it.
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={anchor} className={className} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open &&
        createPortal(
          <div ref={panel} style={style} className="z-50 rounded-md border border-slate-700 bg-slate-950 p-3 text-xs text-slate-300 shadow-xl" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
            {children}
          </div>,
          document.body,
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
