import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { ChatChannel } from "./Chat.js";
import { Button, Card, ErrorText, Field, Input } from "./ui.js";

/** Alliance card: create or join one, manage members, and talk to them. */
export function AlliancePanel({ matchId, state }: { matchId: string; state: MatchStateView }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.alliances(matchId), queryFn: () => api.alliances(matchId), refetchInterval: 30_000 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.alliances(matchId) });
    void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
    void qc.invalidateQueries({ queryKey: keys.chatAll(matchId) });
  };

  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [invitee, setInvitee] = useState("");
  const [showChat, setShowChat] = useState(true);

  const create = useMutation({ mutationFn: () => api.createAlliance(matchId, { name: name.trim(), tag: tag.trim().toUpperCase() }), onSuccess: refresh });
  const accept = useMutation({ mutationFn: (allianceId: string) => api.acceptAllianceInvite(matchId, allianceId), onSuccess: refresh });
  const decline = useMutation({ mutationFn: (allianceId: string) => api.declineAllianceInvite(matchId, allianceId), onSuccess: refresh });
  const invite = useMutation({ mutationFn: (playerId: string) => api.inviteToAlliance(matchId, playerId), onSuccess: () => setInvitee("") });
  const kick = useMutation({ mutationFn: (playerId: string) => api.kickFromAlliance(matchId, playerId), onSuccess: refresh });
  const leave = useMutation({ mutationFn: () => api.leaveAlliance(matchId), onSuccess: refresh });

  const mine = q.data?.mine ?? null;
  const myRole = q.data?.myRole ?? null;
  const canInvite = myRole === "leader" || myRole === "officer";
  const isLeader = myRole === "leader";
  const memberIds = new Set(mine?.members.map((m) => m.playerId) ?? []);
  const invitable = state.players.filter((p) => !p.isAi && p.id !== state.me.playerId && !memberIds.has(p.id));

  if (q.isLoading) {
    return (
      <Card>
        <p className="text-sm text-slate-400">Loading alliance...</p>
      </Card>
    );
  }

  if (!mine) {
    return (
      <Card className="space-y-3">
        <h2 className="text-sm font-medium">Alliance</h2>
        {q.data && q.data.invites.length > 0 && (
          <ul className="space-y-1 text-sm">
            {q.data.invites.map((inv) => (
              <li key={inv.id} className="flex items-center gap-2 rounded bg-slate-950/60 px-2 py-1">
                <span className="flex-1 text-slate-200">
                  [{inv.tag}] {inv.name}
                </span>
                <Button className="px-2 py-1" onClick={() => accept.mutate(inv.allianceId)} disabled={accept.isPending}>
                  Accept
                </Button>
                <Button variant="ghost" className="px-2 py-1" onClick={() => decline.mutate(inv.allianceId)} disabled={decline.isPending}>
                  Decline
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Name">
            <Input value={name} minLength={2} maxLength={30} placeholder="Northern Pact" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Tag">
            <Input value={tag} minLength={2} maxLength={5} placeholder="NP" onChange={(e) => setTag(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
          </Field>
          <Button type="submit" disabled={create.isPending || name.trim().length < 2 || tag.length < 2}>
            Found alliance
          </Button>
          <ErrorText>{create.error?.message ?? accept.error?.message ?? decline.error?.message}</ErrorText>
        </form>
        {q.data && q.data.alliances.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Alliances in this match</h3>
            <ul className="space-y-1 text-sm text-slate-300">
              {q.data.alliances.map((a) => (
                <li key={a.id} className="flex justify-between">
                  <span>
                    [{a.tag}] {a.name}
                  </span>
                  <span className="text-slate-500">
                    {a.members.length} members · {a.regions} regions
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">
          <span className="text-sky-300">[{mine.tag}]</span> {mine.name}
        </h2>
        <span className="text-xs text-slate-500">{mine.regions} regions</span>
      </div>
      <ul className="space-y-1 text-sm">
        {mine.members.map((m) => (
          <li key={m.playerId} className="flex items-center gap-2 text-slate-300">
            <span className={m.playerId === state.me.playerId ? "text-white" : ""}>{m.name}</span>
            <span className="text-xs text-slate-500">{m.role}</span>
            <span className="ml-auto text-slate-500">{m.regions} regions</span>
            {isLeader && m.playerId !== state.me.playerId && (
              <button className="text-xs text-rose-400 hover:underline" onClick={() => kick.mutate(m.playerId)} disabled={kick.isPending}>
                kick
              </button>
            )}
          </li>
        ))}
      </ul>
      {canInvite && (
        <div className="flex gap-2">
          <select className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100" value={invitee} onChange={(e) => setInvitee(e.target.value)}>
            <option value="">Invite a player...</option>
            {invitable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button variant="ghost" onClick={() => invitee && invite.mutate(invitee)} disabled={!invitee || invite.isPending}>
            Invite
          </Button>
        </div>
      )}
      {invite.isSuccess && <p className="text-xs text-emerald-400">Invite sent.</p>}
      <ErrorText>{invite.error?.message ?? kick.error?.message ?? leave.error?.message}</ErrorText>
      <div className="flex items-center justify-between">
        <button className="text-xs text-slate-400 hover:text-slate-200" onClick={() => setShowChat((s) => !s)}>
          {showChat ? "Hide" : "Show"} alliance chat
        </button>
        <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => leave.mutate()} disabled={leave.isPending}>
          Leave
        </Button>
      </div>
      {showChat && <ChatChannel matchId={matchId} channel="alliance" me={state.me.playerId} />}
    </Card>
  );
}
