import { useCallback, useSyncExternalStore } from "react";

/**
 * Who a player has muted in a match's chat: particular players, or the whole room. Kept on this device
 * per match, so a mute never follows you into the next game by accident.
 */
export interface ChatMutes {
  all: boolean;
  players: string[];
}

const EMPTY: ChatMutes = { all: false, players: [] };
const cache = new Map<string, ChatMutes>();
const listeners = new Set<() => void>();

function key(matchId: string): string {
  return `lt_chatmute:${matchId}`;
}

function read(matchId: string): ChatMutes {
  const hit = cache.get(matchId);
  if (hit) return hit;
  let v = EMPTY;
  try {
    const raw = localStorage.getItem(key(matchId));
    if (raw) {
      const p = JSON.parse(raw) as Partial<ChatMutes>;
      v = { all: !!p.all, players: Array.isArray(p.players) ? p.players.filter((x): x is string => typeof x === "string") : [] };
    }
  } catch {
    // no storage: mutes last for the page only
  }
  cache.set(matchId, v);
  return v;
}

function write(matchId: string, v: ChatMutes) {
  cache.set(matchId, v);
  try {
    localStorage.setItem(key(matchId), JSON.stringify(v));
  } catch {
    // ignore
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useChatMutes(matchId: string) {
  const mutes = useSyncExternalStore(subscribe, () => read(matchId), () => EMPTY);
  const isMuted = useCallback((playerId: string) => mutes.all || mutes.players.includes(playerId), [mutes]);
  const toggleAll = useCallback(() => write(matchId, { ...read(matchId), all: !read(matchId).all }), [matchId]);
  const mute = useCallback((playerId: string) => {
    const cur = read(matchId);
    if (!cur.players.includes(playerId)) write(matchId, { ...cur, players: [...cur.players, playerId] });
  }, [matchId]);
  const unmute = useCallback((playerId: string) => {
    const cur = read(matchId);
    write(matchId, { ...cur, players: cur.players.filter((p) => p !== playerId) });
  }, [matchId]);
  return { all: mutes.all, players: mutes.players, isMuted, toggleAll, mute, unmute };
}
