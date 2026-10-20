import { chime } from "../components/chatAlert.js";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { wsServerMessage, type WsClientMessage } from "@lastthaw/shared";
import { keys } from "./client.js";

/**
 * One WebSocket for the match screen. Events are hints only: on any match
 * event we refetch the authoritative state through the normal query.
 */
export function useMatchRealtime(matchId: string | null) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!matchId) return;
    let closedByUs = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Time online counts only while the player is doing something: any touch of the page tells the server, at most every half minute.
    let lastActiveSent = 0;
    const sayActive = () => {
      const ws = wsRef.current;
      const t = Date.now();
      if (document.visibilityState !== "visible" || t - lastActiveSent < 30_000 || ws?.readyState !== ws?.OPEN) return;
      lastActiveSent = t;
      ws?.send(JSON.stringify({ type: "active" } satisfies WsClientMessage));
    };
    const activityEvents = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;
    for (const ev of activityEvents) window.addEventListener(ev, sayActive, { passive: true });
    document.addEventListener("visibilitychange", sayActive);

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
      wsRef.current = ws;
      setStatus("connecting");
      const send = (m: WsClientMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

      ws.onopen = () => {
        retry = 0;
        setStatus("open");
        send({ type: "subscribe", matchId });
        lastActiveSent = 0;
        sayActive();
      };
      ws.onmessage = (ev) => {
        const parsed = wsServerMessage.safeParse(JSON.parse(ev.data as string));
        if (!parsed.success) return;
        const msg = parsed.data;
        if (msg.type === "event") {
          setLastEvent(`${msg.kind} ${new Date(msg.at).toLocaleTimeString()}`);
          void qc.invalidateQueries({ queryKey: keys.matchState(msg.matchId) });
          if (["job.completed", "age.advanced", "message.new", "army.arrived", "region.conquered"].includes(msg.kind)) {
            void qc.invalidateQueries({ queryKey: keys.messages(msg.matchId) });
          }
          if (msg.kind === "match.started" || msg.kind === "match.finished" || msg.kind === "player.joined" || msg.kind === "match.paused" || msg.kind === "match.resumed") {
            void qc.invalidateQueries({ queryKey: keys.matches });
          }
          if (msg.kind === "army.incoming") {
            // Someone is marching on you: a chime now, and the inbox line follows.
            chime();
            void qc.invalidateQueries({ queryKey: keys.messages(msg.matchId) });
          }
          if (msg.kind === "chat.message") {
            const ch = (msg.payload as { channel?: string } | null)?.channel;
            void qc.invalidateQueries({ queryKey: ch ? keys.chat(msg.matchId, ch) : keys.chatAll(msg.matchId) });
          }
          if (msg.kind === "alliance.updated") {
            void qc.invalidateQueries({ queryKey: keys.alliances(msg.matchId) });
            void qc.invalidateQueries({ queryKey: keys.chatAll(msg.matchId) });
          }
          if (msg.kind === "battle.started" || msg.kind === "battle.round" || msg.kind === "battle.ended") {
            void qc.invalidateQueries({ queryKey: keys.battles(msg.matchId) });
          }
          if (msg.kind === "trade.filled") {
            void qc.invalidateQueries({ queryKey: keys.market(msg.matchId) });
            void qc.invalidateQueries({ queryKey: keys.messages(msg.matchId) });
          }
        }
      };
      ws.onclose = () => {
        setStatus("closed");
        if (closedByUs) return;
        // First drop (usually a deploy) reconnects almost at once; then back off to 15s.
        timer = setTimeout(connect, retry === 0 ? 500 : Math.min(15_000, 1000 * 2 ** retry));
        retry += 1;
      };
    };
    connect();

    const ping = setInterval(() => {
      const ws = wsRef.current;
      if (ws?.readyState === ws?.OPEN) ws?.send(JSON.stringify({ type: "ping" } satisfies WsClientMessage));
    }, 25_000);

    return () => {
      closedByUs = true;
      for (const ev of activityEvents) window.removeEventListener(ev, sayActive);
      document.removeEventListener("visibilitychange", sayActive);
      clearInterval(ping);
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [matchId, qc]);

  return { status, lastEvent };
}
