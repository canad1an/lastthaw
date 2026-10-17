import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useChatAlert } from "./chatAlert.js";
import { useChatMutes } from "./chatMutes.js";
import { useEffect, useRef, useState } from "react";
import type { MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, Input } from "./ui.js";

type Channel = "global" | "alliance";

/** Global and alliance chat. Polls every 10 s and refetches on the chat.message event. */
export function Chat({ matchId, state, embedded, initialChannel = "global", quiet }: { matchId: string; state: MatchStateView; embedded?: boolean; initialChannel?: Channel; quiet?: boolean }) {
  const inAlliance = !!state.me.allianceId;
  const mutes = useChatMutes(matchId);
  const nameOf = (id: string) => state.players.find((p) => p.id === id)?.name ?? "a player";
  const [channel, setChannel] = useState<Channel>(inAlliance ? initialChannel : "global");
  useEffect(() => {
    if (!inAlliance && channel === "alliance") setChannel("global");
  }, [inAlliance, channel]);

  const body = (
    <>
      {!embedded && (
        <div className="flex gap-1 text-sm">
          <Tab active={channel === "global"} onClick={() => setChannel("global")}>
            Global
          </Tab>
          {inAlliance && (
            <Tab active={channel === "alliance"} onClick={() => setChannel("alliance")}>
              Alliance{state.me.allianceTag ? ` [${state.me.allianceTag}]` : ""}
            </Tab>
          )}
        </div>
      )}
      <ChatChannel matchId={matchId} channel={channel} me={state.me.playerId} quiet={quiet} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <button
          className={`rounded border px-2 py-1 ${mutes.all ? "border-rose-500/50 bg-rose-500/10 text-rose-200" : "border-slate-700 hover:border-slate-500"}`}
          onClick={mutes.toggleAll}
          title={mutes.all ? "Chat is muted: no chime, no alerts, nothing new shown" : "Mute the whole chat: no chime or alerts until you unmute"}
        >
          {mutes.all ? "🔕 Chat muted · unmute" : "🔕 Mute chat"}
        </button>
        {mutes.players.length > 0 && (
          <span className="flex flex-wrap items-center gap-1">
            Muted:
            {mutes.players.map((id) => (
              <button key={id} className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300 hover:bg-slate-700" onClick={() => mutes.unmute(id)} title="Unmute">
                {nameOf(id)} ✕
              </button>
            ))}
          </span>
        )}
      </div>
    </>
  );
  if (embedded) return <div className="space-y-2">{body}</div>;
  return (
    <Card className="space-y-2">
      <h2 className="text-sm font-medium">Chat</h2>
      {body}
    </Card>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`rounded px-2 py-1 ${active ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function ChatChannel({ matchId, channel, me, quiet }: { matchId: string; channel: Channel; me: string; quiet?: boolean | undefined }) {
  const qc = useQueryClient();
  const mutes = useChatMutes(matchId);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const q = useQuery({ queryKey: keys.chat(matchId, channel), queryFn: () => api.chat(matchId, channel), refetchInterval: 10_000 });
  // A chime for new messages from others, and a flashing tab title while the player is elsewhere.
  // In a match the game's own watcher does this for every channel, so the panel stays quiet there.
  useChatAlert(
    quiet || mutes.all ? undefined : q.data?.messages.filter((m) => !mutes.isMuted(m.playerId)).map((m) => ({ id: m.id, from: m.playerId })),
    me,
    channel === "alliance" ? "Alliance chat" : "New chat message",
  );
  const send = useMutation({
    mutationFn: (body: string) => api.postChat(matchId, channel, body),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: keys.chat(matchId, channel) });
    },
  });
  const count = q.data?.messages.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, channel]);

  const submit = () => {
    const body = text.trim();
    if (body && !send.isPending) send.mutate(body);
  };

  return (
    <div className="space-y-2">
      <ul ref={listRef} className="max-h-56 space-y-1 overflow-y-auto rounded bg-slate-950/60 p-2 text-sm">
        {q.isLoading && <li className="text-slate-500">Loading...</li>}
        {q.error && <li className="text-rose-400">{q.error.message}</li>}
        {q.data?.messages.length === 0 && <li className="text-slate-500">No messages yet.</li>}
        {(q.data?.messages ?? []).filter((m) => m.playerId === me || !mutes.players.includes(m.playerId)).map((m) => (
          <li key={m.id} className="group break-words">
            <span className={`font-medium ${m.playerId === me ? "text-sky-300" : "text-slate-200"}`}>{m.playerName}</span>
            <span className="ml-2 text-xs text-slate-500">{new Date(m.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            {m.playerId !== me && (
              <button className="ml-2 text-[10px] text-slate-600 hover:text-rose-300 sm:opacity-0 sm:group-hover:opacity-100" onClick={() => mutes.mute(m.playerId)} title={`Mute ${m.playerName}: hide their messages and skip the chime`}>
                mute
              </button>
            )}
            <p className="text-slate-300">{m.body}</p>
          </li>
        ))}
        {mutes.players.length > 0 && (q.data?.messages ?? []).some((m) => mutes.players.includes(m.playerId)) && <li className="text-xs text-slate-600">Messages from muted players are hidden.</li>}
      </ul>
      <div className="flex gap-2">
        <Input
          value={text}
          maxLength={500}
          placeholder={channel === "global" ? "Say something to everyone" : "Message your alliance"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button onClick={submit} disabled={!text.trim() || send.isPending}>
          Send
        </Button>
      </div>
      <ErrorText>{send.error?.message}</ErrorText>
    </div>
  );
}
