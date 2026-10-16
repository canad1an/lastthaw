import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePageMeta } from "../seo.js";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type TextareaHTMLAttributes } from "react";
import type { UserView } from "@lastthaw/shared";
import { useMe } from "../api/auth.js";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, Field, Input, fmt } from "../components/ui.js";

interface History {
  history: Array<{ matchId: string; slug?: string; name: string; speed: number; finishedAt: string | null; rank: number; score: number; regions: number; age: string; won: boolean }>;
  active: Array<{ matchId: string; slug?: string; name: string; status: string }>;
  wins: number;
  played: number;
  titles?: Array<{ title: string; n: number }>;
}

/** Profile and account settings: who you are to other players, the account basics, and the password. */
export function ProfilePage() {
  usePageMeta({ title: "Your tribe", noindex: true });
  const me = useMe();
  const q = useQuery({ queryKey: ["me", "history"], queryFn: () => fetch("/api/me/history", { credentials: "include" }).then((r) => r.json() as Promise<History>), enabled: !!me.data });
  if (me.isLoading) return <p className="p-6 text-slate-400">Loading...</p>;
  if (!me.data) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <p className="shadow-copy text-slate-200">Log in to see your profile.</p>
        <Link to="/login" className="btn-ice mt-4 inline-block rounded-md px-4 py-2 text-sm">
          Log in
        </Link>
      </main>
    );
  }
  const u = me.data;
  const joined = u.createdAt ? new Date(u.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long" }) : null;

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:py-12">
      {/* Header */}
      <header className="glass glass-strong flex flex-wrap items-center gap-5 rounded-2xl p-6">
        <div className="display flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400/30 to-amber-400/30 text-4xl font-bold text-white ring-1 ring-sky-300/40">
          {u.displayName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-[0.25em] text-sky-300">Your tribe</p>
          <h1 className="display truncate text-3xl font-bold text-white sm:text-4xl">{u.displayName}</h1>
          <p className="mt-1 text-slate-300">{u.tagline ?? <span className="italic text-slate-500">No tagline yet. Add one below.</span>}</p>
          <p className="mt-1 text-sm text-slate-400">
            {u.location && <span>{u.location} · </span>}
            {joined && <span>Playing since {joined}</span>}
          </p>
          {q.data?.titles && q.data.titles.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-1">
              {q.data.titles.map((t) => (
                <span key={t.title} className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-200">
                  {t.title}
                  {t.n > 1 ? ` ×${t.n}` : ""}
                </span>
              ))}
            </p>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-3 text-center">
          <Stat n={q.data ? String(q.data.played) : "–"} label="matches" />
          <Stat n={q.data ? String(q.data.wins) : "–"} label="wins" />
        </dl>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <AboutForm user={u} />
          <MatchHistory q={q.data} />
        </div>
        <div className="space-y-6">
          <AccountCard user={u} />
          <PasswordCard email={u.email} />
        </div>
      </div>
    </main>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div className="rounded-lg border border-slate-700/40 bg-slate-950/40 px-4 py-2">
      <dd className="display text-2xl font-semibold text-white">{n}</dd>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
    </div>
  );
}

function SectionTitle({ kicker, title, body }: { kicker: string; title: string; body?: string }) {
  return (
    <div className="mb-4">
      <p className="text-xs font-medium uppercase tracking-[0.25em] text-sky-300">{kicker}</p>
      <h2 className="display text-xl font-semibold text-white">{title}</h2>
      {body && <p className="mt-1 text-sm text-slate-400">{body}</p>}
    </div>
  );
}

function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-500 ${className}`}
      {...rest}
    />
  );
}

/** The free-text details other players can read about you. The tribe name itself is fixed at signup. */
function AboutForm({ user }: { user: UserView }) {
  const qc = useQueryClient();
  const [tagline, setTagline] = useState(user.tagline ?? "");
  const [location, setLocation] = useState(user.location ?? "");
  const [bio, setBio] = useState(user.bio ?? "");
  const [tribe, setTribe] = useState(user.displayName);
  useEffect(() => {
    setTribe(user.displayName);
    setTagline(user.tagline ?? "");
    setLocation(user.location ?? "");
    setBio(user.bio ?? "");
  }, [user]);
  const renaming = user.canRename && tribe.trim() !== user.displayName;
  const dirty = renaming || tagline !== (user.tagline ?? "") || location !== (user.location ?? "") || bio !== (user.bio ?? "");
  const m = useMutation({
    mutationFn: () => api.updateProfile({ tagline, location, bio, ...(renaming ? { displayName: tribe.trim() } : {}) }),
    onSuccess: (u) => qc.setQueryData(keys.me, u),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Card className="p-5">
      <SectionTitle kicker="About you" title="What rivals see" body={user.canRename ? "Pick your tribe name below. You choose it once; it is how other players know you in every match." : "Your tribe name is fixed; it is how other players know you across matches. Everything here is yours to change."} />
      <form onSubmit={submit} className="space-y-4">
        {user.canRename && (
          <Field label="Tribe name (one-time pick)">
            <Input value={tribe} onChange={(e) => setTribe(e.target.value)} maxLength={24} placeholder="Letters, digits, spaces, _ or -" />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tagline">
            <Input value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={80} placeholder="A motto, a boast, a warning" />
          </Field>
          <Field label="Where you play from">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={60} placeholder="City, country, or just a time zone" />
          </Field>
        </div>
        <Field label="About">
          <Textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={600} rows={5} placeholder="How you like to play, who you ally with, what you did last match. Up to 600 characters." />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-500">{bio.length}/600</span>
          <div className="flex items-center gap-3">
            {m.isSuccess && !dirty && <span className="text-sm text-emerald-300">Saved</span>}
            <Button type="submit" disabled={!dirty || m.isPending}>
              {m.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </div>
        <ErrorText>{m.error?.message}</ErrorText>
      </form>
    </Card>
  );
}

/** The basics: name, email and verification state. Email is read only; it is the login. */
function AccountCard({ user }: { user: UserView }) {
  const resend = useMutation({ mutationFn: api.resendVerification });
  return (
    <Card className="p-5">
      <SectionTitle kicker="Account" title="The basics" />
      <dl className="divide-y divide-slate-800 text-sm">
        <Row label="Tribe name">
          <span className="text-white">{user.displayName}</span>
          <p className="mt-0.5 text-xs text-slate-500">Chosen at signup and permanent.</p>
        </Row>
        <Row label="Email">
          <span className="break-all text-white">{user.email}</span>
          <div className="mt-1">
            {user.emailVerified ? (
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs text-emerald-300">verified</span>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-300">unverified</span>
                <button className="text-xs text-sky-300 hover:text-white" onClick={() => resend.mutate()} disabled={resend.isPending}>
                  {resend.isSuccess ? "Sent, check your inbox" : "Resend verification email"}
                </button>
              </span>
            )}
          </div>
        </Row>
        <Row label="Member since">
          <span className="text-white">{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "–"}</span>
        </Row>
        {user.isAdmin && (
          <Row label="Role">
            <span className="text-amber-200">Admin</span>
          </Row>
        )}
      </dl>
      <p className="mt-3 text-xs text-slate-500">Email is your login and cannot be changed here. Write to us if you need to move the account to a new address.</p>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-2.5">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

/** Change the password here, or have a reset link emailed instead. */
function PasswordCard({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = useMutation({
    mutationFn: () => api.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
    },
  });
  const reset = useMutation({ mutationFn: () => api.forgot(email) });
  const mismatch = confirm.length > 0 && confirm !== next;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    change.mutate();
  };
  return (
    <Card className="p-5">
      <SectionTitle kicker="Security" title="Password" body="Changing it signs out every other device. This one stays logged in." />
      <form onSubmit={submit} className="space-y-3">
        <Field label="Current password">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label="New password (8+ characters)">
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} required />
        </Field>
        {mismatch && <ErrorText>Those passwords do not match.</ErrorText>}
        <ErrorText>{change.error?.message}</ErrorText>
        {change.isSuccess && <p className="text-sm text-emerald-300">Password changed.</p>}
        <Button type="submit" className="w-full" disabled={change.isPending || mismatch}>
          Change password
        </Button>
      </form>
      <div className="mt-4 border-t border-slate-800 pt-4 text-sm">
        <p className="text-slate-400">Forgot the current one?</p>
        <button className="mt-1 text-sky-300 hover:text-white" onClick={() => reset.mutate()} disabled={reset.isPending || reset.isSuccess}>
          {reset.isSuccess ? "Reset link sent to your email" : "Email me a reset link"}
        </button>
        <ErrorText>{reset.error?.message}</ErrorText>
      </div>
    </Card>
  );
}

function MatchHistory({ q }: { q: History | undefined }) {
  return (
    <Card className="p-5">
      <SectionTitle kicker="Record" title="Your matches" />
      {q?.active.length ? (
        <div className="mb-4">
          <h3 className="mb-1 text-xs uppercase tracking-wide text-slate-500">In progress</h3>
          <ul className="space-y-1 text-sm">
            {q.active.map((a) => (
              <li key={a.matchId} className="flex items-center justify-between">
                <Link to="/match/$matchId" params={{ matchId: a.slug ?? a.matchId }} className="text-sky-300 hover:text-white">
                  {a.name}
                </Link>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">{a.status}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <h3 className="mb-1 text-xs uppercase tracking-wide text-slate-500">Finished</h3>
      {!q && <p className="text-sm text-slate-400">Loading...</p>}
      {q?.history.length === 0 && <p className="text-sm text-slate-400">No finished matches yet. Your first will be recorded here.</p>}
      <ul className="divide-y divide-slate-800 text-sm">
        {q?.history.map((h) => (
          <li key={h.matchId} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              {h.won && <span className="mr-1 text-amber-300">🏆</span>}
              <Link to="/match/$matchId/report" params={{ matchId: h.slug ?? h.matchId }} className="text-slate-100 hover:text-white hover:underline">
                {h.name}
              </Link>{" "}
              <span className="text-slate-500">{h.finishedAt ? new Date(h.finishedAt).toLocaleDateString() : ""}</span>
            </span>
            <span className="text-slate-300">
              #{h.rank} · {h.regions} regions · {h.age} · {fmt(h.score)} pts
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
