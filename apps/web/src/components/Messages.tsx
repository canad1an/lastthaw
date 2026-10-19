import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, keys, type MessageView } from "../api/client.js";

const KIND_ICON: Record<string, string> = { battle: "⚔", scout: "🔭", build: "🔨", research: "📜", trade: "⚖", system: "ℹ", alliance: "🤝" };
const TOAST_MS = 5000;

/** Recent messages list used inside the top menu dropdown. */
export function MessagesList({ messages, matchId, pinned, onSelectRegion }: { messages: MessageView[]; matchId?: string | undefined; pinned?: ReactNode; onSelectRegion?: ((regionId: string) => void) | undefined }) {
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
              <MessageBody m={m} />
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
  if (p.storm || p.thaw || p.plague || p.horde || p.refugees || p.boom || p.wonder || p.objective) return true;
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

function MessageBody({ m }: { m: MessageView }) {
  const p = m.payload as Record<string, unknown>;
  // The subject line says it all; only a battle carries a report worth showing. Ids and flags stay out of sight.
  if (m.kind === "battle" && p.report) return <BattleReport report={p.report as BattleReportPayload} />;
  return null;
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
        {report.attackerName} {report.mission}ed {report.regionName} ({report.defenderName}). {report.attackerWon ? "Attacker won" : "Defender held"} after {report.rounds} rounds.
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
