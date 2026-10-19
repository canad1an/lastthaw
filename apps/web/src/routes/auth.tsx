import { useMe } from "../api/auth.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePageMeta } from "../seo.js";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { api, keys } from "../api/client.js";
import { SignupForm } from "../components/SignupForm.js";
import { Button, ErrorText, Field, Input } from "../components/ui.js";

/** Auth pages share one layout: a pitch on the left, the form in a glass panel on the right. */
function Shell({ title, kicker, pitch, children }: { title: string; kicker?: string; pitch?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-4 py-12 sm:py-20 lg:grid-cols-[1fr_minmax(0,26rem)] lg:items-center">
      <div className="rise">
        {kicker && <p className="shadow-copy mb-3 text-xs font-medium uppercase tracking-[0.25em] text-sky-300">{kicker}</p>}
        <h1 className="display text-4xl font-bold sm:text-5xl">
          <span className="frost-text">{title}</span>
        </h1>
        {pitch && <div className="shadow-copy mt-5 max-w-md space-y-3 text-slate-200">{pitch}</div>}
      </div>
      <div className="glass glass-strong rise rise-2 rounded-2xl p-6 sm:p-7">{children}</div>
    </main>
  );
}

export function LoginPage() {
  usePageMeta({ title: "Log in", description: "Log in to Last Thaw to join a tournament, pick your capital and get back to your empire.", path: "/login" });
  const qc = useQueryClient();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const m = useMutation({
    mutationFn: () => api.login({ email, password }),
    onSuccess: (u) => {
      qc.setQueryData(keys.me, u);
      void nav({ to: "/matches" });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Shell
      kicker="Welcome back"
      title="The ice kept moving."
      pitch={
        <>
          <p>Your build queues finished, your caravans arrived and the line crept a little further south. Log in and see what the night left you.</p>
          <p className="text-sm text-slate-400">
            New here?{" "}
            <Link to="/register" className="text-sky-300 hover:text-white">
              Raise a tribe in thirty seconds
            </Link>
            .
          </p>
        </>
      }
    >
      <h2 className="display mb-4 text-xl font-semibold text-white">Log in</h2>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <ErrorText>{m.error?.message}</ErrorText>
        <Button type="submit" className="display w-full py-3 text-base" disabled={m.isPending}>
          Return to the field
        </Button>
        <p className="text-center text-sm text-slate-400">
          <Link to="/forgot" className="hover:text-white">
            Forgot password?
          </Link>
          {" · "}
          <Link to="/register" className="hover:text-white">
            Create an account
          </Link>
        </p>
      </form>
    </Shell>
  );
}

export function RegisterPage() {
  usePageMeta({ title: "Play free", description: "Create a free Last Thaw account: a 30-day strategy game on a real map of Earth, with weekly tournaments and games you can finish in an afternoon.", path: "/register" });
  return (
    <Shell
      kicker="Free to play"
      title="Five families. One month. The whole Earth."
      pitch={
        <>
          <p>Pick a capital on the real map, set your workers, and start building before the frost reaches your latitude. A new match opens every week.</p>
          <ul className="space-y-1.5 text-sm text-slate-400">
            <li>· No download. Plays in the browser, on a phone or a desk.</li>
            <li>· Ten minutes a day keeps an empire going.</li>
            <li>· Nothing you can buy affects combat or the economy.</li>
          </ul>
        </>
      }
    >
      <h2 className="display mb-1 text-xl font-semibold text-white">Raise your tribe</h2>
      <p className="mb-5 text-sm text-slate-400">Your tribe name is what rivals will see on the map.</p>
      <SignupForm />
    </Shell>
  );
}

export function VerifyPage() {
  usePageMeta({ title: "Verify your email", noindex: true });
  const { token } = useSearch({ from: "/verify" });
  const qc = useQueryClient();
  const me = useMe();
  const [code, setCode] = useState("");
  const m = useMutation({
    mutationFn: (b: { token?: string; code?: string }) => api.verify(b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.me }),
  });
  const resend = useMutation({ mutationFn: api.resendVerification });
  useEffect(() => {
    if (token) m.mutate({ token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const verified = m.isSuccess || !!me.data?.emailVerified;
  return (
    <Shell kicker="One last step" title="Verify your email">
      {verified ? (
        <p className="text-slate-200">
          Your email is verified.{" "}
          <Link to="/matches" className="text-sky-300 hover:underline">
            Find a match
          </Link>
          .
        </p>
      ) : token ? (
        <p className="text-slate-300">{m.isPending ? "Checking your link..." : "Checking your link."}</p>
      ) : me.data ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length === 6) m.mutate({ code });
          }}
        >
          <p className="text-slate-300">
            We sent a six-digit code to <b className="text-white">{me.data.email}</b>. Type it here, or open the link in that mail.
          </p>
          <Field label="Code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className="text-center text-2xl tracking-[0.4em]"
              autoFocus
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={code.length !== 6 || m.isPending}>
              Verify
            </Button>
            <button type="button" className="text-sm text-slate-400 underline hover:text-white" onClick={() => resend.mutate()} disabled={resend.isPending}>
              {resend.isSuccess ? "Sent again; check your inbox and spam" : "Send a new code"}
            </button>
          </div>
        </form>
      ) : (
        <p className="text-slate-300">
          <Link to="/login" className="text-sky-300 hover:underline">
            Log in
          </Link>{" "}
          to enter your code, or open the link from your verification email.
        </p>
      )}
      <ErrorText>{m.error?.message}</ErrorText>
    </Shell>
  );
}

export function ForgotPage() {
  usePageMeta({ title: "Forgot password", description: "Reset your Last Thaw password.", path: "/forgot" });
  const [email, setEmail] = useState("");
  const m = useMutation({ mutationFn: () => api.forgot(email) });
  return (
    <Shell kicker="Account" title="Reset your password">
      {m.isSuccess ? (
        <p className="text-slate-200">If that email has an account, a reset link is on its way.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
          className="space-y-4"
        >
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <ErrorText>{m.error?.message}</ErrorText>
          <Button type="submit" className="w-full" disabled={m.isPending}>
            Send reset link
          </Button>
        </form>
      )}
    </Shell>
  );
}

export function ResetPage() {
  usePageMeta({ title: "Choose a new password", noindex: true });
  const { token } = useSearch({ from: "/reset" });
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const m = useMutation({ mutationFn: () => api.reset(token ?? "", password), onSuccess: () => void nav({ to: "/login" }) });
  return (
    <Shell kicker="Account" title="Choose a new password">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
        className="space-y-4"
      >
        <Field label="New password">
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
        </Field>
        <ErrorText>{m.error?.message}</ErrorText>
        <Button type="submit" className="w-full" disabled={m.isPending || !token}>
          Save password
        </Button>
      </form>
    </Shell>
  );
}
