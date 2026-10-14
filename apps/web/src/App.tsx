import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatCountdown, healthResponse } from "@lastthaw/shared";

async function fetchHealth() {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return healthResponse.parse(await res.json());
}

function useRealtime() {
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [lastTick, setLastTick] = useState<string | null>(null);
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    ws.onopen = () => setStatus("open");
    ws.onclose = () => setStatus("closed");
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as { type: string; serverTime: string };
      setLastTick(msg.serverTime);
    };
    return () => ws.close();
  }, []);
  return { status, lastTick };
}

export function App() {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: 15_000 });
  const rt = useRealtime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const secondsSinceTick = rt.lastTick ? (now - Date.parse(rt.lastTick)) / 1000 : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <h1 className="text-5xl font-semibold tracking-tight">Last Thaw</h1>
      <p className="max-w-md text-balance text-slate-400">
        Thirty days. One freezing Earth. Grow five families into an empire before the ice reaches you.
      </p>
      <dl className="grid w-full grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-left text-sm">
        <dt className="text-slate-400">API</dt>
        <dd>{health.isLoading ? "checking..." : health.isError ? "unreachable" : `ok (v${health.data?.version})`}</dd>
        <dt className="text-slate-400">Server time</dt>
        <dd>{health.data ? new Date(health.data.serverTime).toLocaleTimeString() : "-"}</dd>
        <dt className="text-slate-400">Realtime</dt>
        <dd>{rt.status}</dd>
        <dt className="text-slate-400">Last tick</dt>
        <dd>{secondsSinceTick === null ? "-" : `${formatCountdown(secondsSinceTick)} ago`}</dd>
      </dl>
      <p className="text-xs text-slate-500">Milestone 0 skeleton. Accounts and the world map arrive in milestone 1.</p>
    </main>
  );
}
