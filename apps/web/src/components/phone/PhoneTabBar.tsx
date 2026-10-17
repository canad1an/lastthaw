import type { PhoneTab } from "./screens.js";

const TABS: Array<{ id: PhoneTab; label: string; icon: string }> = [
  { id: "map", label: "Map", icon: "🗺" },
  { id: "region", label: "Region", icon: "📍" },
  { id: "empire", label: "Empire", icon: "🏘" },
  { id: "research", label: "Research", icon: "📜" },
  { id: "more", label: "More", icon: "☰" },
];

/** The bar along the bottom of a phone: five places to be, with a count on the ones that want attention. */
export function PhoneTabBar({ active, onChange, badges, disabled }: { active: PhoneTab; onChange: (t: PhoneTab) => void; badges: Partial<Record<PhoneTab, number | string | undefined>>; disabled?: Partial<Record<PhoneTab, boolean | undefined>> }) {
  return (
    <nav className="z-20 flex shrink-0 border-t border-slate-800 bg-slate-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur" aria-label="Game sections">
      {TABS.map((t) => {
        const on = active === t.id;
        const badge = badges[t.id];
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            disabled={disabled?.[t.id]}
            className={`relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] disabled:opacity-40 ${on ? "text-white" : "text-slate-400 active:text-slate-200"}`}
            aria-current={on ? "page" : undefined}
          >
            <span className={`text-lg leading-none ${on ? "" : "opacity-80"}`} aria-hidden>
              {t.icon}
            </span>
            <span>{t.label}</span>
            {on && <span className="absolute inset-x-5 top-0 h-0.5 rounded-b" style={{ background: "var(--age-accent, #38bdf8)" }} aria-hidden />}
            {badge !== undefined && badge !== 0 && badge !== "" && (
              <span className="absolute right-[18%] top-1.5 rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold leading-4 text-white">{badge}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
