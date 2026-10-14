import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMe } from "../api/auth.js";
import { Button, Card } from "../components/ui.js";

interface Flag {
  id: string;
  reason: string;
  score: number;
  evidence: Record<string, unknown>;
  createdAt: string;
  match: string | null;
  userA: { id: string; email?: string; displayName?: string };
  userB: { id: string; email?: string; displayName?: string };
}

async function post(url: string, body?: unknown) {
  const r = await fetch(url, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!r.ok) throw new Error(`request failed (${r.status})`);
  return r.json();
}

/** Fair-play review queue. Flags are advisory: a human decides. */
export function AdminPage() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "fairplay"],
    queryFn: () => fetch("/api/admin/fairplay", { credentials: "include" }).then((r) => (r.ok ? (r.json() as Promise<{ flags: Flag[] }>) : Promise.reject(new Error("forbidden")))),
    enabled: !!me.data?.isAdmin,
  });
  const review = useMutation({ mutationFn: (v: { id: string; verdict: string }) => post(`/api/admin/fairplay/${v.id}/review`, { verdict: v.verdict }), onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin"] }) });
  const scan = useMutation({ mutationFn: () => post("/api/admin/fairplay/scan"), onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin"] }) });
  if (!me.data?.isAdmin) return <p className="p-6 text-slate-400">Not found.</p>;
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Fair play review</h1>
        <Button variant="ghost" onClick={() => scan.mutate()} disabled={scan.isPending}>
          Scan now
        </Button>
      </div>
      <p className="text-sm text-slate-400">Pairs of accounts sharing a network, device, or sending each other resources. Nothing here is automatic; review and decide.</p>
      {q.data?.flags.length === 0 && <Card>No open flags.</Card>}
      {q.data?.flags.map((f) => (
        <Card key={f.id} className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {f.reason.replace("_", " ")} · score {f.score}
              {f.match ? ` · ${f.match}` : ""}
            </span>
            <span className="text-xs text-slate-500">{new Date(f.createdAt).toLocaleString()}</span>
          </div>
          <p className="text-slate-300">
            {f.userA.displayName ?? f.userA.id} ({f.userA.email ?? "?"}) ↔ {f.userB.displayName ?? f.userB.id} ({f.userB.email ?? "?"})
          </p>
          <pre className="overflow-x-auto rounded bg-slate-950/60 p-2 text-xs text-slate-400">{JSON.stringify(f.evidence)}</pre>
          <div className="flex gap-2">
            {["cleared", "warned", "confirmed"].map((v) => (
              <Button key={v} variant={v === "confirmed" ? "danger" : "ghost"} onClick={() => review.mutate({ id: f.id, verdict: v })}>
                {v}
              </Button>
            ))}
          </div>
        </Card>
      ))}
    </main>
  );
}
