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
        <h1 className="text-3xl font-semibold tracking-tight">Matches</h1>
        <p className="max-w-prose text-slate-400">
          Thirty days. One freezing Earth. Grow five families into an empire before the ice reaches you. Join a match before it starts;
          nobody joins mid-match.
        </p>
      </section>

      {me.data && !me.data.emailVerified && <VerifyBanner />}
      {!me.data && !me.isLoading && (
        <Card>
          <p className="text-slate-300">
            <Link to="/register" className="text-sky-400 hover:underline">
              Create an account
            </Link>{" "}
            or{" "}
            <Link to="/login" className="text-sky-400 hover:underline">
              log in
            </Link>{" "}
            to join a match.
          </p>
        </Card>
      )}

      <div className="space-y-3">
        {matches.isLoading && <p className="text-slate-400">Loading matches...</p>}
        {matches.data?.length === 0 && <p className="text-slate-400">No matches are open right now.</p>}
        {matches.data?.map((m) => <MatchRow key={m.id} m={m} canJoin={!!me.data?.emailVerified} />)}
      </div>

      {me.data?.emailVerified && (me.data.isAdmin || info.data?.devTools) && <CreateMatch admin={!!me.data.isAdmin} />}
    </main>
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
          <h2 className="font-medium">{m.name}</h2>
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
          <Link to="/match/$matchId" params={{ matchId: m.id }} className="rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400">
            {m.status === "lobby" ? (m.capitalRegionId ? "Lobby" : "Pick your start") : "Play"}
          </Link>
        ) : (
          m.status === "lobby" && (
            <Button onClick={() => join.mutate()} disabled={!canJoin || join.isPending} title={canJoin ? "" : "Verify your email first"}>
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
  const [speed, setSpeed] = useState(10);
  const [startsIn, setStartsIn] = useState(5);
  const [aiFillTo, setAiFillTo] = useState(24);
  const [aiDifficulty, setAiDifficulty] = useState<"mixed" | "easy" | "medium" | "hard">("mixed");
  const m = useMutation({
    mutationFn: () => api.createMatch({ name, speed, startsInMinutes: startsIn, aiFillTo, aiDifficulty }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matches }),
  });
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
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Speed">
          <Input type="number" min={1} max={100} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </Field>
        <Field label="Starts in (min)">
          <Input type="number" min={0} value={startsIn} onChange={(e) => setStartsIn(Number(e.target.value))} />
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
