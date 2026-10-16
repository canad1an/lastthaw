import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { formatCountdown, type MatchSummary } from "@lastthaw/shared";
import { useMe } from "../api/auth.js";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, Field, Input } from "../components/ui.js";
import { useNow } from "../hooks/useNow.js";
import { useServerInfo } from "../hooks/useServerInfo.js";

export function LobbyPage() {
  const me = useMe();
  const info = useServerInfo();
  const matches = useQuery({ queryKey: keys.matches, queryFn: api.matches, refetchInterval: 15_000 });

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <section className="space-y-2">
        <p className="shadow-copy text-xs font-medium uppercase tracking-[0.25em] text-sky-300">The field</p>
        <h1 className="display text-4xl font-bold">
          <span className="frost-text">Matches</span>
        </h1>
        <p className="shadow-copy max-w-prose text-slate-200">
          Thirty days. One freezing Earth. Grow five families into an empire before the ice reaches you. Join a match before it starts;
          nobody joins mid-match.
        </p>
      </section>

      {me.data && !me.data.emailVerified && <VerifyBanner />}
      {me.data && me.data.emailVerified && !me.data.approved && (
        <Card className="border-sky-500/40 bg-sky-500/10">
          <p className="text-sm text-sky-100">
            Last Thaw is in private beta. Your account is ready, but matches are invite-only for now: ask Matt for access and this page will open up as soon as you are approved.
          </p>
        </Card>
      )}
      {!me.data && !me.isLoading && (
        <Card className="glass-strong flex flex-wrap items-center justify-between gap-3">
          <p className="text-slate-200">You need an account to claim a capital. It takes thirty seconds and costs nothing.</p>
          <div className="flex gap-2">
            <Link to="/register" className="btn-ember display rounded-md px-4 py-2 text-sm font-semibold">
              Play free
            </Link>
            <Link to="/login" className="btn-ice rounded-md px-4 py-2 text-sm">
              Log in
            </Link>
          </div>
        </Card>
      )}

      <div className="space-y-3">
        {matches.isLoading && <p className="text-slate-400">Loading matches...</p>}
        {matches.data?.length === 0 && <p className="text-slate-400">No matches are open right now.</p>}
        {matches.data?.map((m) => <MatchRow key={m.id} m={m} canJoin={!!me.data?.emailVerified && !!me.data?.approved} />)}
      </div>

      {me.data?.emailVerified && (me.data.isAdmin || info.data?.devTools) && <CreateMatch admin={!!me.data.isAdmin} />}

      <PastMatches />
    </main>
  );
}

interface PastMatch {
  id: string;
  name: string;
  speed: number;
  startsAt: string;
  finishedAt: string | null;
  winnerName: string | null;
  winKind: string | null;
  humans: number;
  players: number;
}

/** Finished matches: open the report, or watch the whole month replayed in thirty seconds. */
function PastMatches() {
  const q = useQuery({
    queryKey: ["past-matches"],
    queryFn: () => fetch("/api/matches/past", { credentials: "include" }).then((r) => r.json() as Promise<{ matches: PastMatch[] }>),
  });
  const list = q.data?.matches ?? [];
  if (list.length === 0) return null;
  const how = (k: string | null) => (k === "hold" ? "held 60% of the world" : k === "wonder" ? "finished the Great Hearth" : k === "survival" ? "outlasted the ice" : k === "score" ? "highest score" : "");
  return (
    <section className="space-y-3">
      <h2 className="display text-xl font-semibold text-white">Past matches</h2>
      <div className="space-y-2">
        {list.map((m) => (
          <Card key={m.id} className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-slate-100">
                {m.name} <span className="text-xs text-slate-500">· {m.speed}x · {m.players} players{m.humans ? `, ${m.humans} human` : ""}</span>
              </p>
              <p className="text-sm text-slate-400">
                {m.finishedAt ? new Date(m.finishedAt).toLocaleDateString() : ""}
                {m.winnerName && (
                  <>
                    {" "}· <span className="text-amber-200">{m.winnerName}</span> won{how(m.winKind) ? `: ${how(m.winKind)}` : ""}
                  </>
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <Link to="/match/$matchId/replay" params={{ matchId: m.id }}>
                <Button variant="ghost">▶ Replay</Button>
              </Link>
              <Link to="/match/$matchId/report" params={{ matchId: m.id }}>
                <Button variant="ghost">Report</Button>
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

function VerifyBanner() {
  const m = useMutation({ mutationFn: api.resendVerification });
  return (
    <Card className="border-amber-500/40 bg-amber-500/10">
      <p className="text-sm text-amber-100">
        Verify your email to join matches. Check your inbox for the link.{" "}
        <button className="underline hover:text-white" onClick={() => m.mutate()} disabled={m.isPending}>
          {m.isSuccess ? "Sent again" : "Resend"}
        </button>
      </p>
    </Card>
  );
}

function MatchRow({ m, canJoin }: { m: MatchSummary; canJoin: boolean }) {
  const qc = useQueryClient();
  const now = useNow(1000);
  const join = useMutation({ mutationFn: () => api.joinMatch(m.id), onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matches }) });
  const startsIn = (Date.parse(m.startsAt) - now) / 1000;
  const endsIn = (Date.parse(m.endsAt) - now) / 1000;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="display font-semibold text-white">{m.name}</h2>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">{m.speed}x</span>
          <span className={`rounded px-1.5 py-0.5 text-xs ${m.status === "running" ? "bg-emerald-500/20 text-emerald-300" : "bg-sky-500/20 text-sky-300"}`}>
            {m.status}
          </span>
        </div>
        <p className="text-sm text-slate-400">
          {m.humanPlayers}/{m.maxPlayers} players ·{" "}
          {m.status === "lobby" ? (startsIn > 0 ? `starts in ${formatCountdown(startsIn)}` : "starting...") : `ends in ${formatCountdown(endsIn)}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {m.joined ? (
          <Link to="/match/$matchId" params={{ matchId: m.id }} className="btn-ember rounded-md px-3 py-2 text-sm font-semibold">
            {m.status === "lobby" ? (m.capitalRegionId ? "Lobby" : "Pick your start") : "Play"}
          </Link>
        ) : (
          m.status === "lobby" && (
            <Button onClick={() => join.mutate()} disabled={!canJoin || join.isPending} title={canJoin ? "" : "Verify your email and ask for beta access first"}>
              Join
            </Button>
          )
        )}
        <ErrorText>{join.error?.message}</ErrorText>
      </div>
    </Card>
  );
}

function CreateMatch({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState("Test match");
  const [speed, setSpeed] = useState(admin ? 1 : 10);
  const [startsIn, setStartsIn] = useState(5);
  const [startsAt, setStartsAt] = useState("");
  const [weekly, setWeekly] = useState(admin);
  const [aiFillTo, setAiFillTo] = useState(20);
  const [aiDifficulty, setAiDifficulty] = useState<"mixed" | "easy" | "medium" | "hard">("mixed");
  const m = useMutation({
    mutationFn: () => api.createMatch({ name, speed, startsInMinutes: startsIn, ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}), weekly, aiFillTo, aiDifficulty }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matches }),
  });
  const suggest = useMutation({ mutationFn: () => api.nameSuggestion(), onSuccess: (r) => setName(r.name) });
  return (
    <Card>
      <h2 className="mb-1 font-medium">Create a match {admin ? "(admin)" : "(dev tool)"}</h2>
      <p className="mb-3 text-xs text-slate-400">
        Players join in the lobby until the start time. At start, AI tribes are added until the match has N players in total (set N to the number of humans for no AI, 100 for a full map). Speed 10 means a 3-day match.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      >
        <Field label="Name">
          <div className="flex gap-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="button" variant="ghost" className="shrink-0 px-2" onClick={() => suggest.mutate()} title="A war-or-winter name nobody has used">
              Suggest
            </Button>
          </div>
        </Field>
        <Field label="Speed">
          <Input type="number" min={1} max={100} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </Field>
        <Field label="Starts at (your time)">
          <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </Field>
        {!startsAt && (
          <Field label="…or starts in (min)">
            <Input type="number" min={0} value={startsIn} onChange={(e) => setStartsIn(Number(e.target.value))} />
          </Field>
        )}
        <Field label="Counts toward the weekly schedule">
          <label className="flex h-10 items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} /> Yes, it is one of the six ahead
          </label>
        </Field>
        <Field label="AI tribes up to">
          <Input type="number" min={0} max={100} value={aiFillTo} onChange={(e) => setAiFillTo(Number(e.target.value))} />
        </Field>
        <Field label="AI difficulty">
          <select value={aiDifficulty} onChange={(e) => setAiDifficulty(e.target.value as typeof aiDifficulty)} className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100">
            <option value="mixed">Mixed</option>
            <option value="easy">Easy</option>
            <option value="medium">Medium</option>
            <option value="hard">Hard</option>
          </select>
        </Field>
        <div className="flex items-end">
          <Button type="submit" className="w-full" disabled={m.isPending}>
            Create
          </Button>
        </div>
      </form>
      <ErrorText>{m.error?.message}</ErrorText>
    </Card>
  );
}
