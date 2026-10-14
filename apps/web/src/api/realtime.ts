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
      };
      ws.onmessage = (ev) => {
        const parsed = wsServerMessage.safeParse(JSON.parse(ev.data as string));
        if (!parsed.success) return;
        const msg = parsed.data;
        if (msg.type === "event") {
          setLastEvent(`${msg.kind} ${new Date(msg.at).toLocaleTimeString()}`);
          void qc.invalidateQueries({ queryKey: keys.matchState(msg.matchId) });
          if (msg.kind === "match.started" || msg.kind === "match.finished" || msg.kind === "player.joined") {
            void qc.invalidateQueries({ queryKey: keys.matches });
          }
        }
      };
      ws.onclose = () => {
        setStatus("closed");
        if (closedByUs) return;
        retry += 1;
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry));
      };
    };
    connect();

    const ping = setInterval(() => {
      const ws = wsRef.current;
      if (ws?.readyState === ws?.OPEN) ws?.send(JSON.stringify({ type: "ping" } satisfies WsClientMessage));
    }, 25_000);

    return () => {
      closedByUs = true;
      clearInterval(ping);
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [matchId, qc]);

  return { status, lastEvent };
}
