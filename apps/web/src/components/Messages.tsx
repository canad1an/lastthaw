import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, keys, type MessageView } from "../api/client.js";

const KIND_ICON: Record<string, string> = { battle: "⚔", scout: "👁", build: "🔨", research: "📜", trade: "⚖", system: "ℹ", alliance: "🤝" };
const TOAST_MS = 5000;

/** Recent messages list used inside the top menu dropdown. */
export function MessagesList({ messages }: { messages: MessageView[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <ul className="divide-y divide-slate-900">
      {messages.length === 0 && <li className="px-3 py-2 text-slate-400">Nothing yet.</li>}
      {messages.map((m) => (
        <li key={m.id}>
          <button className={`w-full px-3 py-1.5 text-left hover:bg-slate-900 ${m.readAt ? "text-slate-400" : "text-slate-100"}`} onClick={() => setSelected(selected === m.id ? null : m.id)}>
            <span className="mr-2">{KIND_ICON[m.kind] ?? "•"}</span>
            {m.subject}
            <span className="ml-2 text-xs text-slate-500">{new Date(m.createdAt).toLocaleTimeString()}</span>
          </button>
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
      if (!suppressed) setToast(newest);
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
  if (m.kind === "battle" && p.report) return <BattleReport report={p.report as BattleReportPayload} />;
  const lines = Object.entries(p).filter(([, v]) => typeof v !== "object");
  if (!lines.length) return null;
  return (
    <dl className="ml-6 grid grid-cols-[auto_1fr] gap-x-3 text-xs text-slate-400">
      {lines.map(([k, v]) => (
        <span key={k} className="contents">
          <dt>{k}</dt>
          <dd>{String(v)}</dd>
        </span>
      ))}
    </dl>
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
