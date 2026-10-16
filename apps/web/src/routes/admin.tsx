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
  matchId: string | null;
  userA: { id: string; email?: string; displayName?: string; suspendedAt?: string | null };
  userB: { id: string; email?: string; displayName?: string; suspendedAt?: string | null };
}

interface BetaUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  emailVerifiedAt: string | null;
  approvedAt: string | null;
  suspendedAt: string | null;
  lastLoginAt: string | null;
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
  const suspend = useMutation({ mutationFn: (v: { id: string; reason: string }) => post(`/api/admin/users/${v.id}/suspend`, { reason: v.reason }), onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin"] }) });
  const unsuspend = useMutation({ mutationFn: (id: string) => post(`/api/admin/users/${id}/unsuspend`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin"] }) });
  const usersQ = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => fetch("/api/admin/users", { credentials: "include" }).then((r) => (r.ok ? (r.json() as Promise<{ users: BetaUser[] }>) : Promise.reject(new Error("forbidden")))),
    enabled: !!me.data?.isAdmin,
  });
  const approve = useMutation({ mutationFn: (id: string) => post(`/api/admin/users/${id}/approve`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin"] }) });
  const revoke = useMutation({ mutationFn: (id: string) => post(`/api/admin/users/${id}/revoke`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin"] }) });
  const kick = useMutation({ mutationFn: (v: { matchId: string; userId: string }) => post(`/api/admin/matches/${v.matchId}/kick/${v.userId}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin"] }) });
  const act = (u: { id: string; displayName?: string; suspendedAt?: string | null }, matchId: string | null) => (
    <span className="inline-flex flex-wrap gap-1">
      {u.suspendedAt ? (
        <Button variant="ghost" onClick={() => unsuspend.mutate(u.id)}>
          unsuspend {u.displayName ?? ""}
        </Button>
      ) : (
        <Button
          variant="danger"
          onClick={() => {
            const reason = window.prompt(`Suspend ${u.displayName ?? u.id}: reason`);
            if (reason) suspend.mutate({ id: u.id, reason });
          }}
        >
          suspend {u.displayName ?? ""}
        </Button>
      )}
      {matchId && (
        <Button variant="ghost" onClick={() => window.confirm(`Kick ${u.displayName ?? u.id} from this match?`) && kick.mutate({ matchId, userId: u.id })}>
          kick {u.displayName ?? ""}
        </Button>
      )}
    </span>
  );
  if (!me.data?.isAdmin) return <p className="p-6 text-slate-400">Not found.</p>;
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">Beta access</h1>
        <p className="text-sm text-slate-400">Only approved accounts can join matches. New sign-ups wait here until you approve them.</p>
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-max text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Player</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Signed up</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(usersQ.data?.users ?? []).map((u) => (
                <tr key={u.id} className="border-t border-slate-800">
                  <td className="px-3 py-1.5">{u.displayName}</td>
                  <td className="px-3 py-1.5 text-slate-400">{u.email}</td>
                  <td className="px-3 py-1.5 text-slate-400">{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td className="px-3 py-1.5">
                    {u.suspendedAt ? <span className="text-rose-300">suspended</span> : u.approvedAt ? <span className="text-emerald-300">approved</span> : !u.emailVerifiedAt ? <span className="text-slate-500">unverified</span> : <span className="text-amber-300">waiting</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {u.approvedAt ? (
                      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => revoke.mutate(u.id)}>
                        revoke
                      </Button>
                    ) : (
                      <Button className="px-2 py-1 text-xs" onClick={() => approve.mutate(u.id)}>
                        approve
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>
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
          <div className="flex flex-wrap gap-2">
            {["cleared", "warned", "confirmed"].map((v) => (
              <Button key={v} variant={v === "confirmed" ? "danger" : "ghost"} onClick={() => review.mutate({ id: f.id, verdict: v })}>
                {v}
              </Button>
            ))}
            <span className="mx-1 h-6 w-px bg-slate-800" />
            {act(f.userA, f.matchId)}
            {act(f.userB, f.matchId)}
          </div>
        </Card>
      ))}
    </main>
  );
}
