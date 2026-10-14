import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, Field, Input } from "../components/ui.js";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-sm px-4 py-12">
      <h1 className="mb-6 text-2xl font-semibold">{title}</h1>
      <Card>{children}</Card>
    </main>
  );
}

export function LoginPage() {
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
    <Shell title="Log in">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <ErrorText>{m.error?.message}</ErrorText>
        <Button type="submit" className="w-full" disabled={m.isPending}>
          Log in
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
  const qc = useQueryClient();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const m = useMutation({
    mutationFn: () => api.register({ email, password, displayName }),
    onSuccess: (u) => {
      qc.setQueryData(keys.me, u);
      void nav({ to: "/matches" });
    },
  });
  return (
    <Shell title="Create your account">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
        className="space-y-4"
      >
        <Field label="Tribe name (shown to other players)">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} minLength={2} maxLength={24} required />
        </Field>
        <Field label="Email">
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password (8+ characters)">
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
        </Field>
        <ErrorText>{m.error?.message}</ErrorText>
        <Button type="submit" className="w-full" disabled={m.isPending}>
          Sign up
        </Button>
        <p className="text-center text-sm text-slate-400">
          Already have an account?{" "}
          <Link to="/login" className="hover:text-white">
            Log in
          </Link>
        </p>
      </form>
    </Shell>
  );
}

export function VerifyPage() {
  const { token } = useSearch({ from: "/verify" });
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.verify(token ?? ""),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.me }),
  });
  useEffect(() => {
    if (token) m.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return (
    <Shell title="Verify email">
      {!token && <p className="text-slate-300">Open the link from your verification email.</p>}
      {m.isPending && <p className="text-slate-300">Checking your link...</p>}
      {m.isSuccess && (
        <p className="text-slate-200">
          Your email is verified.{" "}
          <Link to="/" className="text-sky-400 hover:underline">
            Go to the lobby
          </Link>
          .
        </p>
      )}
      <ErrorText>{m.error?.message}</ErrorText>
    </Shell>
  );
}

export function ForgotPage() {
  const [email, setEmail] = useState("");
  const m = useMutation({ mutationFn: () => api.forgot(email) });
  return (
    <Shell title="Reset password">
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
  const { token } = useSearch({ from: "/reset" });
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const m = useMutation({ mutationFn: () => api.reset(token ?? "", password), onSuccess: () => void nav({ to: "/login" }) });
  return (
    <Shell title="Choose a new password">
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
