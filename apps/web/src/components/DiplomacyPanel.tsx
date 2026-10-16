import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { balance, formatCountdown, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { useNow } from "../hooks/useNow.js";
import { Button, ErrorText, Field, Input, fmt } from "./ui.js";

const RESOURCES = ["food", "wood", "stone", "iron", "copper", "tin", "horses"];

/** Pacts, ceasefires and tribute: propose, answer, give notice, pay. */
export function DiplomacyPanel({ matchId, state, clockOffsetMs }: { matchId: string; state: MatchStateView; clockOffsetMs: number }) {
  const qc = useQueryClient();
  const now = useNow(1000) + clockOffsetMs;
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
  const [other, setOther] = useState("");
  const [kind, setKind] = useState<"nap" | "ceasefire" | "tribute">("nap");
  const [resource, setResource] = useState("food");
  const [amount, setAmount] = useState(1000);
  const propose = useMutation({ mutationFn: () => api.proposePact(matchId, { otherPlayerId: other, kind, ...(kind === "tribute" ? { resource, amount } : {}) }), onSuccess: refresh });
  const respond = useMutation({ mutationFn: (v: { id: string; accept: boolean }) => api.respondPact(matchId, v.id, v.accept), onSuccess: refresh });
  const end = useMutation({ mutationFn: (id: string) => api.endPact(matchId, id), onSuccess: refresh });
  const pay = useMutation({ mutationFn: (id: string) => api.payTribute(matchId, id), onSuccess: refresh });
  const me = state.me.playerId;
  const nameOf = (id: string) => state.players.find((p) => p.id === id)?.name ?? "someone";
  const others = state.players.filter((p) => p.id !== me);
  const d = balance.events.diplomacy;
  const label = (p: MatchStateView["pacts"][number]) => (p.kind === "nap" ? "Non-aggression pact" : p.kind === "ceasefire" ? "Ceasefire" : `Tribute: ${fmt(Number((p.terms as { amount?: number }).amount ?? 0))} ${(p.terms as { resource?: string }).resource ?? ""}`);
  const left = (iso: string | null) => (iso ? formatCountdown(Math.max(0, (Date.parse(iso) - now) / 1000)) : "");
  const incoming = state.pacts.filter((p) => p.status === "proposed" && p.bPlayerId === me);
  const outgoing = state.pacts.filter((p) => p.status === "proposed" && p.aPlayerId === me);
  const standing = state.pacts.filter((p) => p.status === "active" || p.status === "ending" || p.status === "refused");

  return (
    <div className="space-y-4 text-sm">
      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Diplomacy</h3>
        <p className="mb-2 text-xs text-slate-500">
          A pact stops raids and conquests both ways until one side gives {d.napNoticeHours} hours' notice. A ceasefire does the same for {d.ceasefireHours} hours. A tribute demand gives them {d.tributeHours} hours to pay from their capital; refuse it and the demander's raids carry double loot for {d.causeForWarHours} hours.
        </p>
        {incoming.length > 0 && (
          <ul className="mb-2 space-y-1">
            {incoming.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1">
                <span className="flex-1 text-amber-100">
                  <b>{nameOf(p.aPlayerId)}</b> {p.kind === "tribute" ? "demands" : "proposes"} {label(p).toLowerCase()}
                  {p.until && <span className="text-xs text-amber-200/70"> · {left(p.until)} left</span>}
                </span>
                {p.kind === "tribute" ? (
                  <>
                    <Button className="px-2 py-1 text-xs" onClick={() => pay.mutate(p.id)} disabled={pay.isPending || respond.isPending}>
                      Pay from capital
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={() => respond.mutate({ id: p.id, accept: false })}
                      disabled={pay.isPending || respond.isPending}
                      title={`They are told you rejected it, and for ${d.causeForWarHours} hours their raids on you carry double loot.`}
                    >
                      Reject
                    </Button>
                  </>
                ) : (
                  <>
                    <Button className="px-2 py-1 text-xs" onClick={() => respond.mutate({ id: p.id, accept: true })} disabled={respond.isPending}>
                      Accept
                    </Button>
                    <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => respond.mutate({ id: p.id, accept: false })} disabled={respond.isPending}>
                      Decline
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {standing.length === 0 && outgoing.length === 0 && incoming.length === 0 && <p className="text-xs text-slate-500">No pacts yet.</p>}
        <ul className="space-y-1">
          {standing.map((p) => {
            const partner = p.aPlayerId === me ? p.bPlayerId : p.aPlayerId;
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-2 rounded bg-slate-950/60 px-2 py-1 text-slate-300">
                <span className="flex-1">
                  {label(p)} with <b className="text-slate-100">{nameOf(partner)}</b>
                  {p.status === "ending" && <span className="text-xs text-amber-300"> · ends in {left(p.until)}</span>}
                  {p.status === "active" && p.until && <span className="text-xs text-slate-500"> · {left(p.until)} left</span>}
                  {p.status === "refused" && <span className="text-xs text-rose-300"> · refused: {p.aPlayerId === me ? "your" : "their"} raids carry double loot for {left(p.until)}</span>}
                </span>
                {p.kind === "nap" && p.status === "active" && (
                  <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => end.mutate(p.id)} disabled={end.isPending}>
                    Give notice
                  </Button>
                )}
              </li>
            );
          })}
          {outgoing.map((p) => (
            <li key={p.id} className="rounded bg-slate-950/60 px-2 py-1 text-xs text-slate-500">
              Waiting on {nameOf(p.bPlayerId)}: {label(p).toLowerCase()}
              {p.until && ` · ${left(p.until)} left`}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Propose</h4>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="Player">
            <select value={other} onChange={(e) => setOther(e.target.value)} className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100">
              <option value="">Choose…</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.aiLevel ? ` (AI ${p.aiLevel})` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Offer">
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100">
              <option value="nap">Non-aggression pact</option>
              <option value="ceasefire">Ceasefire ({d.ceasefireHours}h)</option>
              <option value="tribute">Demand tribute</option>
            </select>
          </Field>
          {kind === "tribute" ? (
            <div className="flex gap-1">
              <Field label="Amount">
                <Input type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
              </Field>
              <Field label="Of">
                <select value={resource} onChange={(e) => setResource(e.target.value)} className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100">
                  {RESOURCES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : (
            <div />
          )}
        </div>
        {(() => {
          // One open proposal of a kind per pair: say so instead of letting a second click bounce off the server.
          const dup = outgoing.find((p) => p.kind === kind && p.bPlayerId === other) ?? incoming.find((p) => p.kind === kind && p.aPlayerId === other);
          return (
            <>
              {dup && other && (
                <p className="mt-2 text-xs text-amber-200">
                  {dup.aPlayerId === me ? `Your ${label(dup).toLowerCase()} to ${nameOf(other)} is still open` : `${nameOf(other)} already has an open ${label(dup).toLowerCase()} with you`}
                  {dup.until ? ` (${left(dup.until)} left)` : ""}; wait for an answer or for it to run out.
                </p>
              )}
              <Button className="mt-2" onClick={() => propose.mutate()} disabled={!other || propose.isPending || !!dup}>
                {kind === "tribute" ? "Send the demand" : "Propose"}
              </Button>
            </>
          );
        })()}
        <ErrorText>{propose.error?.message ?? respond.error?.message ?? end.error?.message ?? pay.error?.message}</ErrorText>
      </section>
    </div>
  );
}
