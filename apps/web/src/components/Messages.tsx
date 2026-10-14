import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, keys, type MessageView } from "../api/client.js";
import { Card } from "./ui.js";

const KIND_ICON: Record<string, string> = { battle: "⚔", scout: "👁", build: "🔨", research: "📜", trade: "⚖", system: "ℹ", alliance: "🤝" };

/** The message centre: battle reports, scout reports, finished builds, trades. */
export function Messages({ matchId }: { matchId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MessageView | null>(null);
  const q = useQuery({ queryKey: keys.messages(matchId), queryFn: () => api.messages(matchId), refetchInterval: 30_000 });
  const markRead = useMutation({ mutationFn: () => api.markMessagesRead(matchId), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.messages(matchId) }) });
  const unread = q.data?.unread ?? 0;

  return (
    <Card className="space-y-2">
      <button
        className="flex w-full items-center justify-between text-sm font-medium"
        onClick={() => {
          setOpen((o) => !o);
          if (!open && unread) markRead.mutate();
        }}
      >
        <span>Messages</span>
        <span className={`rounded px-1.5 py-0.5 text-xs ${unread ? "bg-rose-500/30 text-rose-200" : "bg-slate-800 text-slate-400"}`}>{unread ? `${unread} new` : q.data?.messages.length ?? 0}</span>
      </button>
      {open && (
        <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
          {q.data?.messages.length === 0 && <li className="text-slate-400">Nothing yet.</li>}
          {q.data?.messages.map((m) => (
            <li key={m.id}>
              <button
                className={`w-full rounded px-2 py-1 text-left hover:bg-slate-800 ${m.readAt ? "text-slate-400" : "text-slate-100"}`}
                onClick={() => setSelected(selected?.id === m.id ? null : m)}
              >
                <span className="mr-2">{KIND_ICON[m.kind] ?? "•"}</span>
                {m.subject}
                <span className="ml-2 text-xs text-slate-500">{new Date(m.createdAt).toLocaleTimeString()}</span>
              </button>
              {selected?.id === m.id && <MessageBody m={m} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
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
    <div className="ml-6 space-y-1 rounded bg-slate-950/60 p-2 text-xs text-slate-400">
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
