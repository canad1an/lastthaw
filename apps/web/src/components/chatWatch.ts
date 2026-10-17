import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { chime, flashTitle } from "./chatAlert.js";
import { useChatMutes } from "./chatMutes.js";

export interface ChatToast {
  channel: "global" | "alliance";
  playerId: string;
  playerName: string;
  body: string;
}

const TOAST_MS = 6000;

/**
 * Watches the match chat the whole time you are in the game, not only while the panel is open:
 * a new message from someone you have not muted chimes, flashes the tab title when you are elsewhere,
 * shows for a few seconds in the bar, and counts as unread until the chat is opened.
 */
export function useChatWatch(matchId: string, state: MatchStateView, chatOpen: boolean) {
  const me = state.me.playerId;
  const inAlliance = !!state.me.allianceId;
  const global = useQuery({ queryKey: keys.chat(matchId, "global"), queryFn: () => api.chat(matchId, "global"), refetchInterval: 15_000 });
  const alliance = useQuery({ queryKey: keys.chat(matchId, "alliance"), queryFn: () => api.chat(matchId, "alliance"), refetchInterval: 15_000, enabled: inAlliance });
  const mutes = useChatMutes(matchId);
  const seen = useRef<Set<string> | null>(null);
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState<ChatToast | null>(null);

  useEffect(() => {
    const all = [
      ...(global.data?.messages ?? []).map((m) => ({ ...m, channel: "global" as const })),
      ...(alliance.data?.messages ?? []).map((m) => ({ ...m, channel: "alliance" as const })),
    ];
    if (!global.data) return;
    // The first load is history, not news.
    if (seen.current === null) {
      seen.current = new Set(all.map((m) => m.id));
      return;
    }
    const fresh = all.filter((m) => !seen.current!.has(m.id));
    for (const m of fresh) seen.current.add(m.id);
    const theirs = fresh.filter((m) => m.playerId !== me && !mutes.isMuted(m.playerId));
    if (theirs.length === 0) return;
    const last = theirs[theirs.length - 1]!;
    chime();
    setToast({ channel: last.channel, playerId: last.playerId, playerName: last.playerName, body: last.body });
    if (!chatOpen) setUnread((n) => n + theirs.length);
    if (document.visibilityState !== "visible" || !document.hasFocus()) flashTitle(last.channel === "alliance" ? "Alliance chat" : "New chat message", theirs.length);
  }, [global.data, alliance.data, me, mutes, chatOpen]);

  useEffect(() => {
    if (chatOpen) setUnread(0);
  }, [chatOpen, global.data, alliance.data]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  return { unread: mutes.all ? 0 : unread, toast: mutes.all ? null : toast, clearToast: () => setToast(null), mutedAll: mutes.all };
}
