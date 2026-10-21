import { useEffect, useRef } from "react";

import { effectsEnabled, openAudio } from "../audio/sound.js";

/** Two short tones, generated on the spot so there is no file to load, and a short buzz where the device can. Silent until the user has touched the page (browser rule). */
export function chime() {
  if (!effectsEnabled()) return;
  try {
    if ("vibrate" in navigator) navigator.vibrate?.(120);
  } catch {
    /* no vibration: fine */
  }
  try {
    const ctx = openAudio();
    if (!ctx) return;
    const at = ctx.currentTime;
    for (const [i, freq] of [660, 880].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.12, at + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + i * 0.14 + 0.13);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at + i * 0.14);
      osc.stop(at + i * 0.14 + 0.15);
    }
  } catch {
    /* no audio: fine */
  }
}

let flashTimer: ReturnType<typeof setInterval> | null = null;
let originalTitle: string | null = null;
let unread = 0;

/** Alternate the tab title with "(n) label" until the tab is looked at again. */
export function flashTitle(label: string, add = 0) {
  unread += add;
  if (originalTitle === null) originalTitle = document.title;
  const base = originalTitle;
  if (flashTimer) clearInterval(flashTimer);
  let on = false;
  flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? `(${unread}) ${label}` : base;
  }, 1000);
  const stop = () => {
    if (document.visibilityState !== "visible" && !document.hasFocus()) return;
    if (flashTimer) clearInterval(flashTimer);
    flashTimer = null;
    unread = 0;
    if (originalTitle !== null) document.title = originalTitle;
    originalTitle = null;
    document.removeEventListener("visibilitychange", stop);
    window.removeEventListener("focus", stop);
  };
  document.addEventListener("visibilitychange", stop);
  window.addEventListener("focus", stop);
}

/**
 * When a message from someone else arrives: a chime, and if the tab is in the
 * background, the tab title flashes with the unread count until the player
 * comes back. The first load never alerts.
 */
export function useChatAlert(messages: Array<{ id: string; from: string }> | undefined, me: string, label = "New message") {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!messages) return;
    if (seen.current === null) {
      seen.current = new Set(messages.map((m) => m.id));
      return;
    }
    const fresh = messages.filter((m) => !seen.current!.has(m.id));
    for (const m of fresh) seen.current.add(m.id);
    const theirs = fresh.filter((m) => m.from !== me);
    if (theirs.length === 0) return;
    chime();
    if (document.visibilityState !== "visible" || !document.hasFocus()) {
      unread += theirs.length;
      flashTitle(label);
    }
  }, [messages, me, label]);
}
