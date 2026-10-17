import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 1023px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function read(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(QUERY).matches;
}

/**
 * The one phone-or-desktop decision for the match page, the same line as Tailwind's `lg`:
 * below it the game is a set of app screens over the map; at or above it, the map with a side column.
 */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
