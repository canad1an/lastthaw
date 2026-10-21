import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, keys, type MessageView } from "../api/client.js";

const KIND_ICON: Record<string, string> = { battle: "⚔", scout: "🔭", build: "🔨", research: "📜", trade: "⚖", system: "ℹ", alliance: "🤝" };
const TOAST_MS = 5000;

/** Recent messages list used inside the top menu dropdown. */
export function MessagesList({ messages, matchId, pinned, onSelectRegion, onOpenBattle }: { messages: MessageView[]; matchId?: string | undefined; pinned?: ReactNode; onSelectRegion?: ((regionId: string) => void) | undefined; onOpenBattle?: ((battleId: string) => void) | undefined }) {
  // Whatever opened the inbox, being on screen is reading it: unread messages are marked read here as well as by the menu.
  const qc = useQueryClient();
  const anyUnread = messages.some((m) => !m.readAt);
  useEffect(() => {
    if (!matchId || !anyUnread) return;
    void api.markMessagesRead(matchId).then(() => qc.invalidateQueries({ queryKey: keys.messages(matchId) })).catch(() => {});
  }, [matchId, anyUnread, qc]);
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyImportant, setOnlyImportant] = useState(true);
  const shown = onlyImportant ? messages.filter(isImportant) : messages;
  return (
    <ul className="divide-y divide-slate-900">
      {pinned && <li className="px-3 py-2">{pinned}</li>}
      <li className="flex items-center justify-between px-3 py-1.5 text-xs text-slate-400">
        <span>{onlyImportant ? `${shown.length} important of ${messages.length}` : `${messages.length} messages`}</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={onlyImportant} onChange={(e) => setOnlyImportant(e.target.checked)} className="accent-sky-400" />
          important only
        </label>
      </li>
      {shown.length === 0 && <li className="px-3 py-2 text-slate-400">Nothing yet.</li>}
      {shown.map((m) => (
        <li key={m.id}>
          <div className={`flex w-full items-start gap-1 px-3 py-1.5 hover:bg-slate-900 ${m.readAt ? "text-slate-400" : "text-slate-100"}`}>
            <button className="min-w-0 flex-1 text-left" onClick={() => setSelected(selected === m.id ? null : m.id)}>
              <span className="mr-2">{KIND_ICON[m.kind] ?? "•"}</span>
              {m.subject}
              <span className="ml-2 text-xs text-slate-500">{new Date(m.createdAt).toLocaleTimeString()}</span>
            </button>
            {/* A battle report opens the battle itself: the replay stays for the whole match. */}
            {onOpenBattle && typeof (m.payload as { battleId?: unknown }).battleId === "string" && (
              <button
                className="shrink-0 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-xs text-rose-100 hover:bg-rose-500/20"
                onClick={() => onOpenBattle((m.payload as { battleId: string }).battleId)}
                title="Replay this battle from the first march"
                data-watch-battle
              >
                Watch battle ▶
              </button>
            )}
            {/* A message about a region opens that region, notes and all, with one tap. */}
            {onSelectRegion && typeof (m.payload as { regionId?: unknown }).regionId === "string" && (
              <button
                className="shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-500/20"
                onClick={() => onSelectRegion((m.payload as { regionId: string }).regionId)}
                title="Open this region on the map, with your notes on it"
              >
                Open region →
              </button>
            )}
          </div>
          {selected === m.id && (
            <div className="px-3 pb-2">
              <MessageBody m={m} onSelectRegion={onSelectRegion} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export const messageIcon = (kind: string) => KIND_ICON[kind] ?? "•";

/** Toast state: the newest message, shown for a few seconds when it first arrives. */
/**
 * Which messages deserve an alert. Routine traffic (builds done, goods
 * delivered, troops arrived) stays in the inbox but never toasts or counts.
 */
export function isImportant(m: MessageView): boolean {
  if (m.kind === "battle" || m.kind === "alliance" || m.kind === "scout") return true;
  const p = (m.payload ?? {}) as Record<string, unknown>;
  if (p.storm || p.thaw || p.plague || p.horde || p.refugees || p.boom || p.wonder || p.objective || p.advisor) return true;
  if (m.kind === "system") {
    const s = m.subject;
    return !(s.startsWith("Troops arrived") || s.startsWith("Army returned") || /joined the occupiers|are on their way there|founded a new home/.test(s));
  }
  return false;
}

export function useMessageToast(matchId: string, suppressed: boolean) {
  const q = useQuery({ queryKey: keys.messages(matchId), queryFn: () => api.messages(matchId), refetchInterval: 20_000 });
  const [toast, setToast] = useState<MessageView | null>(null);
  const lastSeen = useRef<string | null>(null);
  const newest = q.data?.messages[0] ?? null;
  useEffect(() => {
    if (!newest) return;
    if (lastSeen.current === null) {
      lastSeen.current = newest.id;
      return;
    }
    if (newest.id !== lastSeen.current) {
      lastSeen.current = newest.id;
      if (!suppressed && isImportant(newest)) setToast(newest);
    }
  }, [newest, suppressed]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);
  return { q, toast, clearToast: () => setToast(null) };
}

function MessageBody({ m, onSelectRegion }: { m: MessageView; onSelectRegion?: ((regionId: string) => void) | undefined }) {
  const p = m.payload as Record<string, unknown>;
  // The subject line says it all; only a battle carries a report worth showing, and a fallen realm its region list. Ids and flags stay out of sight.
  if (m.kind === "battle" && p.report) return <BattleReport report={p.report as BattleReportPayload} />;
  if (p.realmTaken && Array.isArray(p.regions)) return <RealmList regions={p.regions as RealmRegion[]} onSelectRegion={onSelectRegion} compact />;
  return null;
}

export interface RealmRegion {
  id: string;
  name: string;
  people: number;
  buildings: number;
  capital: boolean;
}

/** The regions that came with a capital, each a tap from the map. */
function RealmList({ regions, onSelectRegion, compact = false }: { regions: RealmRegion[]; onSelectRegion?: ((regionId: string) => void) | undefined; compact?: boolean }) {
  return (
    <ul className={compact ? "ml-6 space-y-0.5 text-xs text-slate-400" : "divide-y divide-slate-900 text-sm"}>
      {regions.map((r) => (
        <li key={r.id} className={`flex items-center gap-2 ${compact ? "" : "px-4 py-2"}`}>
          <span className="min-w-0 flex-1 truncate">
            <span className={compact ? "text-slate-300" : "text-slate-100"}>{r.name}</span>
            {r.capital && <span className="ml-1 rounded bg-amber-500/20 px-1 py-0.5 text-[10px] text-amber-200">their capital</span>}
            <span className="ml-2 text-slate-500">
              {r.people.toLocaleString("en-US")} people{r.buildings ? ` · ${r.buildings} building${r.buildings === 1 ? "" : "s"}` : ""}
            </span>
          </span>
          {onSelectRegion && (
            <button className="shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-500/20" onClick={() => onSelectRegion(r.id)}>
              Open region →
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

const SEEN_KEY = "lt_realm_seen";
function seenRealms(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function markRealmSeen(id: string): void {
  try {
    const s = seenRealms();
    s.add(id);
    localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-50)));
  } catch {
    // Nothing to do: the popup will show again next time, which is harmless.
  }
}

/**
 * A capital you took: a popup naming every region that came with it, each with Open region. Shown once per such
 * message, the first time the page sees it (an unread one from while you were away counts), then only from the inbox.
 */
export function RealmTakenPopup({ messages, onSelectRegion }: { messages: MessageView[]; onSelectRegion: (regionId: string) => void }) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => seenRealms());
  const fresh = messages.find((m) => (m.payload as { realmTaken?: unknown } | null)?.realmTaken && !m.readAt && !dismissed.has(m.id));
  useEffect(() => {
    if (!fresh) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!fresh) return null;
  const p = fresh.payload as { loserName?: string | null; regions?: RealmRegion[] };
  const regions = p.regions ?? [];
  const close = () => {
    markRealmSeen(fresh.id);
    setDismissed((s) => new Set([...s, fresh.id]));
  };
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/90 backdrop-blur-sm" onClick={close} data-realm-popup>
      <div className="relative mx-auto my-6 w-full max-w-lg px-3 sm:my-10" onClick={(e) => e.stopPropagation()}>
        <div className="overflow-hidden rounded-2xl border border-amber-500/40 bg-slate-950 shadow-2xl">
          <div className="bg-gradient-to-b from-amber-500/20 to-transparent px-5 pb-4 pt-6 text-center">
            <p className="text-xs uppercase tracking-[0.3em] text-amber-300">A capital has fallen</p>
            <h1 className="mt-2 text-2xl font-bold text-white">{p.loserName ? `${p.loserName}'s realm is yours` : "The realm is yours"}</h1>
            <p className="mt-2 text-sm text-slate-300">
              {regions.length} region{regions.length === 1 ? "" : "s"} and everyone in them came with the capital, as freshly conquered land. Tap one to go there.
            </p>
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            <RealmList
              regions={regions}
              onSelectRegion={(id) => {
                close();
                onSelectRegion(id);
              }}
            />
          </div>
          <div className="flex justify-end border-t border-slate-800 px-4 py-3">
            <button className="btn-ember rounded-md px-4 py-2 text-sm font-semibold" onClick={close}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface BattleReportPayload {
  regionName: string;
  mission: string;
  attackerName: string;
  defenderName: string;
  attackerWon: boolean;
  rounds: number;
  attacker: { before: Record<string, number>; losses: Record<string, number> };
  defender: { before: Record<string, number>; losses: Record<string, number> };
  loot?: Record<string, number>;
  conquered?: boolean;
}

function BattleReport({ report }: { report: BattleReportPayload }) {
  const side = (label: string, s: { before: Record<string, number>; losses: Record<string, number> }) => (
    <div>
      <p className="font-medium text-slate-200">{label}</p>
      <ul>
        {Object.entries(s.before).map(([u, n]) => (
          <li key={u}>
            {u}: {n} → {n - (s.losses[u] ?? 0)}
          </li>
        ))}
        {Object.keys(s.before).length === 0 && <li>nobody</li>}
      </ul>
    </div>
  );
  return (
    <div className="ml-6 space-y-1 rounded bg-slate-900/60 p-2 text-xs text-slate-400">
      <p>
        {report.attackerName} {report.mission === "airstrike" ? "bombed" : report.mission === "raid" ? "raided" : "attacked"} {report.regionName} ({report.defenderName}). {report.attackerWon ? "Attacker won" : "Defender held"} after {report.rounds} rounds.
        {report.conquered ? " The region was conquered." : ""}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {side("Attacker", report.attacker)}
        {side("Defender", report.defender)}
      </div>
      {report.loot && Object.keys(report.loot).length > 0 && (
        <p>
          Loot:{" "}
          {Object.entries(report.loot)
            .map(([k, v]) => `${Math.round(v)} ${k}`)
            .join(", ")}
        </p>
      )}
    </div>
  );
}
