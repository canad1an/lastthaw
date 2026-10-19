import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePageMeta } from "../seo.js";
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
  isAdmin: boolean;
}

interface Metrics {
  at: string;
  online: { users: Array<{ id: string; name: string; matches: string[] }>; sockets: number; anonymous: number; processes: number };
  active15m: Array<{ id: string; name: string; lastSeenAt: string }>;
  users: { total: number; verified: number; approved: number; suspended: number; new24h: number; new7d: number; loggedIn24h: number; loggedIn7d: number };
  matches: {
    finished: number;
    finished24h: number;
    open: Array<{ id: string; name: string; status: string; speed: number; kind: string; day: number; humans: number; ai: number; online: number; lastTickAgeSeconds: number | null; paused: boolean; jobs: { open: number; due: number; parked: number; doneHour: number } }>;
  };
  activity: { battles24h: number; chat24h: number; events24h: number; sessions7d: number };
  processes: { workerBeatSeconds: number | null; aiBeatSeconds: number | null; lobbiesOverdue: number };
}

function Stat({ n, label, tone }: { n: number | string; label: string; tone?: "good" | "warn" | "bad" | undefined }) {
  const color = tone === "bad" ? "text-rose-300" : tone === "warn" ? "text-amber-200" : tone === "good" ? "text-emerald-300" : "text-white";
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
      <p className={`text-2xl font-semibold tabular-nums ${color}`}>{n}</p>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
    </div>
  );
}

/** Who is here and whether the machinery is turning: refreshed every fifteen seconds. */
function LiveMetrics() {
  const q = useQuery({
    queryKey: ["admin", "metrics"],
    queryFn: () => fetch("/api/admin/metrics", { credentials: "include" }).then((r) => r.json() as Promise<Metrics>),
    refetchInterval: 15_000,
  });
  const d = q.data;
  if (!d) return <Card>Loading metrics...</Card>;
  const running = d.matches.open.filter((m) => m.status === "running");
  const stale = running.filter((m) => !m.paused && (m.lastTickAgeSeconds ?? 0) > 900);
  const parked = running.reduce((a, m) => a + m.jobs.parked, 0);
  const due = running.reduce((a, m) => a + m.jobs.due, 0);
  const age = (s: number | null) => (s === null ? "never" : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`);
  const workerDown = d.processes.workerBeatSeconds === null || d.processes.workerBeatSeconds > 30;
  const aiDown = d.processes.aiBeatSeconds === null || d.processes.aiBeatSeconds > 90;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-semibold">Right now</h1>
        <p className="text-xs text-slate-500">
          as of {new Date(d.at).toLocaleTimeString()} ·{" "}
          <a href="https://stats.lastthaw.com" target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
            page views in Matomo
          </a>
        </p>
      </div>
      {(workerDown || aiDown || d.processes.lobbiesOverdue > 0) && (
        <div className="rounded-lg border border-rose-500/50 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
          {workerDown && <p>The worker is down: no heartbeat {d.processes.workerBeatSeconds === null ? "at all" : `for ${d.processes.workerBeatSeconds}s`}. Nothing completes, no match starts and no reminders go out until it is back.</p>}
          {aiDown && <p>The AI process is down: no heartbeat {d.processes.aiBeatSeconds === null ? "at all" : `for ${d.processes.aiBeatSeconds}s`}. AI tribes are standing still.</p>}
          {d.processes.lobbiesOverdue > 0 && <p>{d.processes.lobbiesOverdue} match{d.processes.lobbiesOverdue === 1 ? "" : "es"} past the start time and still in the lobby.</p>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat n={workerDown ? "DOWN" : `${d.processes.workerBeatSeconds}s ago`} label="worker heartbeat" tone={workerDown ? "bad" : "good"} />
        <Stat n={aiDown ? "DOWN" : `${d.processes.aiBeatSeconds}s ago`} label="AI heartbeat" tone={aiDown ? "bad" : "good"} />
        <Stat n={d.processes.lobbiesOverdue} label="lobbies past start" tone={d.processes.lobbiesOverdue > 0 ? "bad" : "good"} />
        <Stat n={d.online.users.length} label="online now" tone={d.online.users.length > 0 ? "good" : undefined} />
        <Stat n={d.active15m.length} label="active last 15 min" />
        <Stat n={running.length} label="matches running" />
        <Stat n={running.reduce((a, m) => a + m.humans, 0)} label="humans in matches" />
        <Stat n={d.users.total} label={`accounts (${d.users.approved} approved)`} />
        <Stat n={d.users.new7d} label={`new this week (${d.users.new24h} today)`} />
        <Stat n={d.users.loggedIn24h} label="logged in today" />
        <Stat n={d.activity.battles24h} label="battles today" />
        <Stat n={due} label="jobs late by over a minute" tone={due > 0 ? "bad" : "good"} />
        <Stat n={parked} label="jobs parked" tone={parked > 0 ? "bad" : undefined} />
        <Stat n={stale.length} label="matches not ticking" tone={stale.length > 0 ? "bad" : "good"} />
        <Stat n={d.online.sockets} label={`sockets on ${d.online.processes} api process${d.online.processes === 1 ? "" : "es"}`} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="text-sm">
          <p className="mb-1 font-medium text-slate-200">Online now</p>
          {d.online.users.length === 0 && <p className="text-slate-500">Nobody has the site open{d.online.anonymous ? ` (${d.online.anonymous} not logged in)` : ""}.</p>}
          <ul className="space-y-0.5">
            {d.online.users.map((u) => (
              <li key={u.id} className="flex justify-between gap-2">
                <span>{u.name}</span>
                <span className="text-slate-500">{u.matches.length ? `in ${u.matches.join(", ")}` : "lobby or site"}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="text-sm">
          <p className="mb-1 font-medium text-slate-200">Active in the last 15 minutes</p>
          {d.active15m.length === 0 && <p className="text-slate-500">Nobody.</p>}
          <ul className="space-y-0.5">
            {d.active15m.map((u) => (
              <li key={u.id} className="flex justify-between gap-2">
                <span>{u.name}</span>
                <span className="text-slate-500">{new Date(u.lastSeenAt).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-max text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Match</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Day</th>
              <th className="px-3 py-2 text-right">Humans</th>
              <th className="px-3 py-2 text-right">Online</th>
              <th className="px-3 py-2 text-right">AI</th>
              <th className="px-3 py-2">Last tick</th>
              <th className="px-3 py-2 text-right">Jobs open / late / parked</th>
              <th className="px-3 py-2 text-right">Done last hour</th>
            </tr>
          </thead>
          <tbody>
            {d.matches.open.map((m) => (
              <tr key={m.id} className="border-t border-slate-800">
                <td className="px-3 py-1.5">
                  {m.name} <span className="text-xs text-slate-500">· {m.kind} · {m.speed}x</span>
                </td>
                <td className="px-3 py-1.5">{m.paused ? <span className="text-amber-200">paused</span> : m.status}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.status === "running" ? m.day.toFixed(1) : "–"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.humans}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.online}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.ai}</td>
                <td className={`px-3 py-1.5 ${m.status === "running" && !m.paused && (m.lastTickAgeSeconds ?? 0) > 900 ? "text-rose-300" : "text-slate-400"}`}>{m.status === "running" ? age(m.lastTickAgeSeconds) : "–"}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${m.jobs.parked > 0 ? "text-rose-300" : ""}`}>
                  {m.jobs.open} / {m.jobs.due} / {m.jobs.parked}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.jobs.doneHour}</td>
              </tr>
            ))}
            {d.matches.open.length === 0 && (
              <tr>
                <td className="px-3 py-2 text-slate-500" colSpan={9}>
                  No open matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-slate-500">
        {d.matches.finished} finished matches ({d.matches.finished24h} today) · {d.activity.chat24h} chat messages and {d.activity.events24h} world events in the last day · {d.activity.sessions7d} logins this week
      </p>
    </section>
  );
}

async function post(url: string, body?: unknown) {
  const r = await fetch(url, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!r.ok) throw new Error(`request failed (${r.status})`);
  return r.json();
}

/** Fair-play review queue. Flags are advisory: a human decides. */
export function AdminPage() {
  usePageMeta({ title: "Admin", noindex: true });
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
  const setAdmin = useMutation({
    mutationFn: ({ id, admin }: { id: string; admin: boolean }) => post(`/api/admin/users/${id}/admin`, { admin }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin"] }),
  });
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
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-6">
      <LiveMetrics />
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
                    {u.isAdmin && <span className="ml-2 rounded bg-sky-500/20 px-1.5 py-0.5 text-xs text-sky-200">admin</span>}
                  </td>
                  <td className="space-x-1 px-3 py-1.5 text-right">
                    {u.id !== me.data?.id && (
                      <Button
                        variant="ghost"
                        className="px-2 py-1 text-xs"
                        title={u.isAdmin ? "Take back admin rights" : "Grant admin rights: the admin page, approvals, pausing and starting matches"}
                        onClick={() => {
                          if (window.confirm(u.isAdmin ? `Remove admin rights from ${u.displayName}?` : `Make ${u.displayName} an admin? They will see everything on this page and can approve, suspend and kick players.`)) setAdmin.mutate({ id: u.id, admin: !u.isAdmin });
                        }}
                      >
                        {u.isAdmin ? "remove admin" : "make admin"}
                      </Button>
                    )}
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
      <PlayerStats enabled={!!me.data?.isAdmin} />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Fair play review</h1>
        <Button variant="ghost" onClick={() => scan.mutate()} disabled={scan.isPending}>
          Scan now
        </Button>
      </div>
      <p className="text-sm text-slate-400">Pairs of accounts sharing a network, device, or sending each other resources, and single accounts whose commands come at a machine's rhythm (flat intervals, active round the clock). Nothing here is automatic; review and decide.</p>
      {q.data?.flags.length === 0 && <Card>No open flags.</Card>}
      {q.data?.flags.map((f) => (
        <Card key={f.id} className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {f.reason.startsWith("automation") ? `automation (${f.reason.slice("automation_".length)})` : f.reason.replace("_", " ")} · score {f.score}
              {f.match ? ` · ${f.match}` : ""}
            </span>
            <span className="text-xs text-slate-500">{new Date(f.createdAt).toLocaleString()}</span>
          </div>
          <p className="text-slate-300">
            {f.userA.id === f.userB.id ? (
              <>
                {f.userA.displayName ?? f.userA.id} ({f.userA.email ?? "?"})
              </>
            ) : (
              <>
                {f.userA.displayName ?? f.userA.id} ({f.userA.email ?? "?"}) ↔ {f.userB.displayName ?? f.userB.id} ({f.userB.email ?? "?"})
              </>
            )}
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


interface PlayerStat {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  approved: boolean;
  suspended: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
  lastSeenAt: string | null;
  lastCommandAt: string | null;
  hoursOnline: number;
  longestSessionMinutes: number;
  sessions: number;
  logins: number;
  topDevice: string | null;
  devices: Array<{ key: string; n: number }>;
  activeHoursUtc: Array<{ hour: number; n: number }>;
  played: number;
  ranked: number;
  wins: number;
  eliminated: number;
  points: number;
  bestRank: number | null;
  avgRank: number | null;
  commands: number;
  messages: number;
  battles: number;
  battlesWon: number;
  techs: number;
  peakScore: number;
  topAge: number;
  tribes: number;
}

const AGE_NAMES = ["Stone", "Bronze", "Iron", "Classical", "Medieval", "Industrial", "Modern"];
const ago = (iso: string | null) => (iso ? `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 3600_000))} h ago` : "never");

/** Everything tracked per account. Only admins see this; players never see each other's figures. */
function PlayerStats({ enabled }: { enabled: boolean }) {
  const q = useQuery({
    queryKey: ["admin", "player-stats"],
    queryFn: () => fetch("/api/admin/player-stats", { credentials: "include" }).then((r) => (r.ok ? (r.json() as Promise<{ players: PlayerStat[] }>) : Promise.reject(new Error("forbidden")))),
    enabled,
    refetchInterval: 60_000,
  });
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<keyof PlayerStat>("hoursOnline");
  const rows = [...(q.data?.players ?? [])].sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0));
  const Th = ({ k, label, title }: { k: keyof PlayerStat; label: string; title?: string }) => (
    <th className="px-2 py-2 text-right">
      <button className={`hover:text-white ${sort === k ? "text-sky-300" : ""}`} onClick={() => setSort(k)} title={title ?? `Sort by ${label}`}>
        {label}
      </button>
    </th>
  );
  return (
    <section className="space-y-2">
      <h1 className="text-2xl font-semibold">Players</h1>
      <p className="text-sm text-slate-400">
        Every account with everything tracked about it: time online, sessions and logins, the devices and browsers they play on, the hours they play, their matches, results and points, commands, chat, battles, techs and peak score. Click a column to sort; click a row for the device and hour breakdown. None of this is shown to players.
      </p>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-xs">
          <thead className="text-left uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-2 py-2">Player</th>
              <th className="px-2 py-2">Device</th>
              <Th k="hoursOnline" label="Hours" title="Time connected to the game, in hours" />
              <Th k="sessions" label="Sessions" />
              <Th k="logins" label="Logins" />
              <Th k="played" label="Matches" />
              <Th k="wins" label="Wins" />
              <Th k="points" label="Points" />
              <Th k="commands" label="Cmds" title="Game commands sent (last week kept)" />
              <Th k="messages" label="Chat" />
              <Th k="battles" label="Battles" />
              <Th k="techs" label="Techs" />
              <Th k="peakScore" label="Peak" title="Highest score in any match" />
              <th className="px-2 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Fragment key={p.id}>
                <tr className="cursor-pointer border-t border-slate-800 hover:bg-slate-900/60" onClick={() => setOpen(open === p.id ? null : p.id)}>
                  <td className="px-2 py-1.5">
                    <span className="text-slate-100">{p.name}</span>
                    {p.isAdmin && <span className="ml-1 rounded bg-sky-500/20 px-1 text-[10px] text-sky-200">admin</span>}
                    {p.suspended && <span className="ml-1 rounded bg-rose-500/20 px-1 text-[10px] text-rose-200">suspended</span>}
                    <span className="block text-[10px] text-slate-500">{p.email}</span>
                  </td>
                  <td className="px-2 py-1.5 text-slate-300">{p.topDevice ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.hoursOnline}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.sessions}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.logins}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.played}{p.ranked ? <span className="text-slate-500"> ({p.ranked} ranked)</span> : null}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.wins}{p.eliminated ? <span className="text-rose-300"> / {p.eliminated} out</span> : null}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.points.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.commands}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.messages}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.battlesWon}/{p.battles}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.techs}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.peakScore.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-slate-400">{ago(p.lastSeenAt ?? p.lastLoginAt)}</td>
                </tr>
                {open === p.id && (
                  <tr className="border-t border-slate-900 bg-slate-950/60">
                    <td colSpan={14} className="px-3 py-2 text-slate-300">
                      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
                        <p>
                          <span className="text-slate-500">Devices:</span> {p.devices.length ? p.devices.map((d) => `${d.key} (${d.n})`).join(", ") : "none recorded yet"}
                        </p>
                        <p>
                          <span className="text-slate-500">Plays at (UTC):</span> {p.activeHoursUtc.length ? p.activeHoursUtc.map((h) => `${String(h.hour).padStart(2, "0")}:00 (${h.n})`).join(", ") : "no sessions yet"}
                        </p>
                        <p>
                          <span className="text-slate-500">Longest session:</span> {p.longestSessionMinutes} min
                        </p>
                        <p>
                          <span className="text-slate-500">Ranks:</span> best {p.bestRank ?? "—"}, average {p.avgRank ?? "—"} across {p.played} matches; {p.tribes} tribes founded; highest age {AGE_NAMES[p.topAge] ?? p.topAge}
                        </p>
                        <p>
                          <span className="text-slate-500">Joined:</span> {p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—"} · last login {ago(p.lastLoginAt)} · last command {ago(p.lastCommandAt)}
                        </p>
                        <p>
                          <span className="text-slate-500">Battles won:</span> {p.battlesWon} of {p.battles} · chat messages {p.messages} · commands on record {p.commands}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}
