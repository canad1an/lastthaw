import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useChatAlert } from "../components/chatAlert.js";
import { balance, formatCountdown, type MatchSummary } from "@lastthaw/shared";
import { useMe } from "../api/auth.js";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, Field, Input } from "../components/ui.js";
import { useNow } from "../hooks/useNow.js";
import { useServerInfo } from "../hooks/useServerInfo.js";

interface LobbyMessage {
  id: string;
  userId: string;
  name: string;
  body: string;
  sentAt: string;
}

/** One room for everyone between matches: who is about, who wants a game, trash talk before the ice. */
function LobbyChat({ meId, approved }: { meId: string; approved: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const q = useQuery({
    queryKey: ["chat", "lobby"],
    queryFn: () => fetch("/api/chat/lobby", { credentials: "include" }).then((r) => (r.ok ? (r.json() as Promise<{ messages: LobbyMessage[] }>) : { messages: [] })),
    refetchInterval: 8_000,
  });
  const send = useMutation({
    mutationFn: async (body: string) => {
      const r = await fetch("/api/chat/lobby", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ body }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `could not send (${r.status})`);
      return r.json();
    },
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["chat", "lobby"] });
    },
  });
  const count = q.data?.messages.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);
  useChatAlert(
    q.data?.messages.map((m) => ({ id: m.id, from: m.userId })),
    meId,
    "Lobby chat",
  );
  return (
    <Card className="space-y-2">
      <h2 className="display text-lg font-semibold text-white">Lobby chat</h2>
      <ul ref={listRef} className="max-h-72 space-y-1 overflow-y-auto text-sm">
        {count === 0 && <li className="text-slate-500">Nobody has said anything yet. Say hello.</li>}
        {q.data?.messages.map((m) => (
          <li key={m.id} className="flex gap-2">
            <span className="shrink-0 tabular-nums text-xs text-slate-500">{new Date(m.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span>
              <span className={m.userId === meId ? "font-medium text-sky-300" : "font-medium text-slate-200"}>{m.name}</span> <span className="text-slate-300">{m.body}</span>
            </span>
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send.mutate(text.trim());
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder={approved ? "Say something to everyone in the lobby" : "Chat opens once your account is approved"} disabled={!approved} />
        <Button type="submit" disabled={!approved || !text.trim() || send.isPending}>
          Send
        </Button>
      </form>
      {send.error && <ErrorText>{send.error.message}</ErrorText>}
    </Card>
  );
}

export function LobbyPage() {
  const me = useMe();
  const info = useServerInfo();
  const matches = useQuery({ queryKey: keys.matches, queryFn: api.matches, refetchInterval: 15_000 });

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <section className="space-y-2">
        <p className="shadow-copy text-xs font-medium uppercase tracking-[0.25em] text-sky-300">The field</p>
        <h1 className="display text-4xl font-bold">
          <span className="frost-text">Tournaments</span>
        </h1>
        <p className="shadow-copy max-w-prose text-slate-200">
          Thirty days. One freezing Earth. Grow five families into an empire before the ice reaches you. Tournaments start every week and are
          the only games that count toward the Hall of Fame. Join before the start; nobody joins mid-match.
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
        {matches.isLoading && <p className="text-slate-400">Loading tournaments...</p>}
        {matches.data?.filter((m) => m.kind === "tournament").length === 0 && !matches.isLoading && <p className="text-slate-400">No tournament is open right now.</p>}
        {matches.data?.filter((m) => m.kind === "tournament").map((m) => <MatchRow key={m.id} m={m} canJoin={!!me.data?.emailVerified && !!me.data?.approved} />)}
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Games</h2>
            <p className="text-sm text-slate-400">Player-made matches, public or private. Fun, not ranked.</p>
          </div>
          {me.data?.emailVerified && me.data.approved && <JoinByCode />}
        </div>
        {matches.data?.filter((m) => m.kind !== "tournament").length === 0 && <p className="text-sm text-slate-500">No games open. Create one below.</p>}
        {matches.data?.filter((m) => m.kind !== "tournament").map((m) => <MatchRow key={m.id} m={m} canJoin={!!me.data?.emailVerified && !!me.data?.approved} />)}
      </section>

      {me.data?.emailVerified && (me.data.approved || me.data.isAdmin || info.data?.devTools) && <CreateMatch admin={!!me.data.isAdmin} />}

      <PastMatches />
      {me.data && <LobbyChat meId={me.data.id} approved={me.data.approved} />}
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
  kind?: string;
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
                {m.name} <span className="text-xs text-slate-500">· {m.kind === "tournament" ? "tournament" : "game"} · {m.speed}x · {m.players} players{m.humans ? `, ${m.humans} human` : ""}</span>
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
                <Button variant="ghost">Review</Button>
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

/** Enter a private game's invite code: finds the game and joins it. */
function JoinByCode() {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const m = useMutation({
    mutationFn: async () => {
      const found = await api.joinByCode(code);
      await api.joinMatch(found.id, code);
      return found;
    },
    onSuccess: () => {
      setCode("");
      void qc.invalidateQueries({ queryKey: keys.matches });
    },
  });
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) m.mutate();
      }}
    >
      <Field label="Invite code">
        <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. 7F3A9C1B" className="w-40 font-mono" maxLength={16} />
      </Field>
      <Button type="submit" variant="ghost" disabled={m.isPending || !code.trim()}>
        Join private game
      </Button>
      {m.error && <ErrorText>{m.error.message}</ErrorText>}
    </form>
  );
}

function MatchRow({ m, canJoin }: { m: MatchSummary; canJoin: boolean }) {
  const qc = useQueryClient();
  const now = useNow(1000);
  const [copied, setCopied] = useState(false);
  const join = useMutation({
    mutationFn: () => {
      const code = m.kind === "private" && !m.createdByMe ? window.prompt("This is a private game. Enter its invite code:") ?? "" : undefined;
      return api.joinMatch(m.id, code || undefined);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matches }),
  });
  const register = useMutation({
    mutationFn: () => (m.registered ? api.unregisterTournament(m.id) : api.registerTournament(m.id)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matches }),
  });
  const startsIn = (Date.parse(m.startsAt) - now) / 1000;
  const endsIn = (Date.parse(m.endsAt) - now) / 1000;
  // Tournaments take registrations until the lobby opens an hour before the start; then everyone joins.
  const opensIn = m.joinOpensAt ? (Date.parse(m.joinOpensAt) - now) / 1000 : 0;
  const registering = m.kind === "tournament" && m.status === "lobby" && opensIn > 0;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="display font-semibold text-white">{m.name}</h2>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">{m.speed}x</span>
          <span className={`rounded px-1.5 py-0.5 text-xs ${m.status === "running" ? "bg-emerald-500/20 text-emerald-300" : "bg-sky-500/20 text-sky-300"}`}>
            {m.status}
          </span>
          {m.kind === "tournament" ? (
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-200" title="Scheduled and ranked">tournament</span>
          ) : m.kind === "private" ? (
            <span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-300" title="Needs the invite code">private</span>
          ) : (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">public game</span>
          )}
          {m.inviteCode && (
            <button
              className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-xs text-slate-200 hover:bg-slate-800"
              title="Invite code: click to copy. Share it with the people you want in."
              onClick={() => {
                void navigator.clipboard?.writeText(m.inviteCode!).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "copied" : `code ${m.inviteCode}`}
            </button>
          )}
        </div>
        <p className="text-sm text-slate-400">
          {registering
            ? `${m.registrations} registered · lobby opens in ${formatCountdown(opensIn)} · starts in ${formatCountdown(startsIn)}`
            : m.status === "lobby"
              ? `${m.humanPlayers} joined, AI tribes fill the rest of ${m.maxPlayers} · ${startsIn > 0 ? `starts in ${formatCountdown(startsIn)}` : "starting..."}`
              : `${m.players}/${m.maxPlayers} players · ends in ${formatCountdown(endsIn)}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {m.joined ? (
          <Link to={m.status === "lobby" ? "/match/$matchId/lobby" : "/match/$matchId"} params={{ matchId: m.id }} className="btn-ember rounded-md px-3 py-2 text-sm font-semibold">
            {m.status === "lobby" ? (m.capitalRegionId ? "Lobby" : "Pick your start") : "Play"}
          </Link>
        ) : registering ? (
          <Button variant={m.registered ? "ghost" : "primary"} onClick={() => register.mutate()} disabled={!canJoin || register.isPending} title={canJoin ? (m.registered ? "You will get a reminder a day ahead and when the lobby opens" : "We mail you a day ahead and when the lobby opens") : "Verify your email and ask for beta access first"}>
            {m.registered ? "Registered ✓" : "Register"}
          </Button>
        ) : (
          m.status === "lobby" && (
            <Button onClick={() => join.mutate()} disabled={!canJoin || join.isPending} title={canJoin ? "" : "Verify your email and ask for beta access first"}>
              Join
            </Button>
          )
        )}
        <ErrorText>{join.error?.message ?? register.error?.message}</ErrorText>
      </div>
    </Card>
  );
}

function CreateMatch({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [speed, setSpeed] = useState(admin ? 1 : 10);
  const [startsIn, setStartsIn] = useState(30);
  const [startsAt, setStartsAt] = useState("");
  const [kind, setKind] = useState<"tournament" | "public" | "private">(admin ? "tournament" : "public");
  const [aiFillTo, setAiFillTo] = useState(20);
  const [aiDifficulty, setAiDifficulty] = useState<"mixed" | "easy" | "medium" | "hard">("mixed");
  const m = useMutation({
    mutationFn: () => api.createMatch({ name, speed, startsInMinutes: startsIn, ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}), kind, aiFillTo, aiDifficulty }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matches }),
  });
  const suggest = useMutation({ mutationFn: () => api.nameSuggestion(), onSuccess: (r) => setName(r.name) });
  return (
    <Card>
      <h2 className="mb-1 font-medium">{admin ? "Create a tournament or game" : "Create a game"}</h2>
      <p className="mb-3 text-xs text-slate-400">
        Players join in the lobby until the start time; AI tribes fill the rest up to the number you set. Speed 1 is the thirty-day pace; 10 means a three-day match. Private games get an invite code to share.
        {admin ? " Tournaments are the scheduled, ranked kind." : " Games are not ranked; tournaments are."}
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
            <Button type="button" variant="ghost" className="shrink-0 px-2" onClick={() => suggest.mutate()} disabled={suggest.isPending} title="A war-or-winter name nobody has used">
              {suggest.isPending ? "…" : "Suggest"}
            </Button>
          </div>
          {suggest.error && <ErrorText>{suggest.error.message}</ErrorText>}
        </Field>
        <Field label="Speed">
          <Input type="number" min={1} max={admin ? 1000 : balance.match.maxGameSpeed} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
          <p className="mt-1 text-xs text-slate-500">1x is a real month; {balance.match.maxGameSpeed}x is the whole match in about four hours.</p>
        </Field>
        <Field label="Starts at (your time)">
          <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </Field>
        {!startsAt && (
          <Field label="…or starts in (min)">
            <Input type="number" min={0} value={startsIn} onChange={(e) => setStartsIn(Number(e.target.value))} />
          </Field>
        )}
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100">
            {admin && <option value="tournament">Tournament (ranked, scheduled)</option>}
            <option value="public">Public game</option>
            <option value="private">Private game (invite code)</option>
          </select>
        </Field>
        <Field label="AI tribes up to">
          <Input type="number" min={0} max={balance.match.maxAiTribes} value={aiFillTo} onChange={(e) => setAiFillTo(Number(e.target.value))} />
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
          <Button type="submit" className="w-full" disabled={m.isPending || !name.trim()}>
            Create
          </Button>
        </div>
      </form>
      {m.data?.inviteCode && (
        <p className="mt-2 text-sm text-emerald-200">
          Private game created. Invite code: <span className="font-mono">{m.data.inviteCode}</span>. Share it; joiners enter it on this page.
        </p>
      )}
      <ErrorText>{m.error?.message}</ErrorText>
    </Card>
  );
}
