import { useSyncExternalStore } from "react";
import { getAudioSettings, play, setAudioSettings, subscribeAudio, type AudioSettings } from "./sound.js";

/** The sound settings as React state: one subscription to the audio module. */
export function useAudioSettings(): AudioSettings {
  return useSyncExternalStore(subscribeAudio, getAudioSettings, getAudioSettings);
}

/** The Sound menu: effects and music switches and one volume, remembered on this device. */
export function AudioControls() {
  const s = useAudioSettings();
  return (
    <div className="space-y-3 p-3 text-sm" data-audio-controls>
      <p className="text-xs text-slate-400">Sounds and music are made in your browser as the game plays, so nothing loads and nothing is sent. Settings are remembered on this device. Browsers only allow sound after you have tapped the page, so a fresh tab stays quiet until you touch something.</p>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={s.effects} onChange={(e) => { setAudioSettings({ effects: e.target.checked }); if (e.target.checked) play("build"); }} className="mt-0.5 accent-sky-400" />
        <span>
          <span className="text-slate-100">Sound effects</span>
          <span className="block text-xs text-slate-400">A chime when a build or research finishes, an army arrives, a battle starts or ends, a message comes in, or someone marches on you.</span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={s.music} onChange={(e) => setAudioSettings({ music: e.target.checked })} className="mt-0.5 accent-sky-400" />
        <span>
          <span className="text-slate-100">Music</span>
          <span className="block text-xs text-slate-400">A quiet loop for the age you are in, changing as you advance. It pauses while the tab is hidden.</span>
        </span>
      </label>
      <label className="flex items-center gap-3">
        <span className="w-16 text-slate-300">Volume</span>
        <input type="range" min={0} max={100} value={Math.round(s.volume * 100)} onChange={(e) => setAudioSettings({ volume: Number(e.target.value) / 100 })} onPointerUp={() => play("click")} className="flex-1 accent-sky-400" aria-label="Volume" />
        <span className="w-10 text-right tabular-nums text-slate-400">{Math.round(s.volume * 100)}%</span>
      </label>
      <button type="button" className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800" onClick={() => play("battle_end")}>
        Test sound
      </button>
    </div>
  );
}
