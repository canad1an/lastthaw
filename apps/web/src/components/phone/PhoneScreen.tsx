import type { ReactNode } from "react";

/**
 * A full screen over the map on phones: a header with a back arrow and a title, then a scrolling body.
 * The map stays mounted underneath, so going back never loses where you had panned to.
 */
export function PhoneScreen({ title, onBack, right, children, flush }: { title: ReactNode; onBack: () => void; right?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <div data-phone-screen className="absolute inset-0 z-10 flex flex-col bg-slate-950" role="dialog" aria-label={typeof title === "string" ? title : undefined}>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-slate-800 bg-slate-950/95 px-1">
        <button onClick={onBack} className="flex h-11 min-w-11 items-center justify-center rounded-md text-xl text-slate-200 active:bg-slate-800" aria-label="Back">
          ←
        </button>
        <h2 data-phone-title className="min-w-0 flex-1 truncate text-base font-semibold text-white">{title}</h2>
        {right && <span className="flex shrink-0 items-center gap-1 pr-1">{right}</span>}
      </div>
      {/* Sideways overflow is clipped: a phone screen scrolls down, never across, whatever a row inside tries. */}
      <div data-phone-body className={`min-h-0 w-full max-w-full flex-1 overflow-x-hidden overflow-y-auto overscroll-contain break-words [&_*]:min-w-0 ${flush ? "" : "space-y-3 p-3"}`}>{children}</div>
    </div>
  );
}
