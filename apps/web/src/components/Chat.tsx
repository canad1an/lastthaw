import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useChatAlert } from "./chatAlert.js";
import { useEffect, useRef, useState } from "react";
import type { MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, Input } from "./ui.js";

type Channel = "global" | "alliance";

/** Global and alliance chat. Polls every 10 s and refetches on the chat.message event. */
export function Chat({ matchId, state, embedded, initialChannel = "global" }: { matchId: string; state: MatchStateView; embedded?: boolean; initialChannel?: Channel }) {
  const inAlliance = !!state.me.allianceId;
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
      <ChatChannel matchId={matchId} channel={channel} me={state.me.playerId} />
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

export function ChatChannel({ matchId, channel, me }: { matchId: string; channel: Channel; me: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const q = useQuery({ queryKey: keys.chat(matchId, channel), queryFn: () => api.chat(matchId, channel), refetchInterval: 10_000 });
  // A chime for new messages from others, and a flashing tab title while the player is elsewhere.
  useChatAlert(
    q.data?.messages.map((m) => ({ id: m.id, from: m.playerId })),
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
        {q.data?.messages.map((m) => (
          <li key={m.id} className="break-words">
            <span className={`font-medium ${m.playerId === me ? "text-sky-300" : "text-slate-200"}`}>{m.playerName}</span>
            <span className="ml-2 text-xs text-slate-500">{new Date(m.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <p className="text-slate-300">{m.body}</p>
          </li>
        ))}
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
