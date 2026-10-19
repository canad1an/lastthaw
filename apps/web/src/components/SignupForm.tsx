import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { api, keys } from "../api/client.js";
import { ErrorText, Field, Input } from "./ui.js";

/** Create-account form used on the landing page hero and the register page. */
export function SignupForm({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const m = useMutation({
    mutationFn: () => api.register({ email, password, displayName }),
    onSuccess: (u) => {
      qc.setQueryData(keys.me, u);
      // Straight to the code: the mail is on its way, and nothing opens until the address is confirmed.
      void nav({ to: "/verify", search: { token: undefined } });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Tribe name">
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} minLength={2} maxLength={24} placeholder="Shown to other players" required />
      </Field>
      <Field label="Email">
        <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
      </Field>
      <Field label="Password">
        <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} placeholder="8+ characters" required />
      </Field>
      <ErrorText>{m.error?.message}</ErrorText>
      <button type="submit" className="btn-ember display w-full rounded-md px-5 py-3 text-base font-semibold" disabled={m.isPending}>
        {m.isPending ? "Raising your tribe..." : "Claim your land"}
      </button>
      <p className={`text-center text-slate-400 ${compact ? "text-xs" : "text-sm"}`}>
        Free forever. No purchases affect the game.{" "}
        <Link to="/login" className="text-sky-300 hover:text-white">
          Already playing? Log in
        </Link>
      </p>
    </form>
  );
}
