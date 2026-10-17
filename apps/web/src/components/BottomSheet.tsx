import { useRef, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";

export type SheetStop = "peek" | "half" | "full";

const ORDER: SheetStop[] = ["peek", "half", "full"];

/** Height of each stop on a phone; the panel is a normal side column on large screens. */
export function sheetHeight(stop: SheetStop): string {
  // Full stops short of the top bar and menu bar (about 9.5rem together), so the handle and its buttons are always on screen.
  return stop === "peek" ? "7.5rem" : stop === "half" ? "50dvh" : "calc(100dvh - 9.5rem)";
}

/**
 * The side panel as a draggable bottom sheet on phones: three stops (peek,
 * half, full) reached by dragging the handle, tapping it, or by the map
 * (select a region → half; tap it again → full). On `lg` screens and up the
 * sheet is just the side column it always was.
 */
export function BottomSheet({ stop, onStop, summary, children, className = "" }: { stop: SheetStop; onStop: (s: SheetStop) => void; summary: ReactNode; children: ReactNode; className?: string }) {
  const drag = useRef<{ id: number; y: number; moved: boolean } | null>(null);
  const step = (dir: 1 | -1) => {
    const i = ORDER.indexOf(stop);
    onStop(ORDER[Math.max(0, Math.min(ORDER.length - 1, i + dir))]!);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { id: e.pointerId, y: e.clientY, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (Math.abs(e.clientY - d.y) > 6) d.moved = true;
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const dy = e.clientY - d.y;
    if (!d.moved) step(stop === "full" ? -1 : 1);
    else if (dy < -40) step(1);
    else if (dy > 40) step(-1);
  };
  return (
    <aside
      style={{ ["--sheet-h" as string]: sheetHeight(stop) }}
      className={`flex flex-col border-slate-800 bg-slate-950 max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-20 max-lg:h-[var(--sheet-h)] max-lg:rounded-t-2xl max-lg:border-t max-lg:shadow-[0_-8px_24px_rgba(0,0,0,0.5)] max-lg:transition-[height] max-lg:duration-200 lg:w-96 lg:border-l ${className}`}
    >
      <div className="touch-none select-none px-4 pt-2 lg:hidden" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => (drag.current = null)}>
        <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-slate-600" style={{ background: "var(--age-accent, #475569)" }} aria-hidden />
        <div className="flex min-h-10 items-center justify-between gap-2 text-sm">
          <div className="min-w-0 flex-1 truncate text-slate-200">{summary}</div>
          {/* Explicit controls beside the drag handle: the buttons stop the handle's own tap-to-step so a tap never doubles up. */}
          <span className="flex shrink-0 items-center gap-1" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
            {stop !== "peek" && (
              <button className="rounded px-2 py-1 text-xs text-slate-400" onClick={() => step(-1)} aria-label="Smaller panel">
                ▾
              </button>
            )}
            {stop !== "full" && (
              <button className="rounded px-2 py-1 text-xs text-slate-400" onClick={() => step(1)} aria-label="Bigger panel">
                ▴
              </button>
            )}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pt-2 lg:pt-4">{children}</div>
    </aside>
  );
}
