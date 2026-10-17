import { Link } from "@tanstack/react-router";
import { regionById, type MatchStateView } from "@lastthaw/shared";
import { PhoneScreen } from "./PhoneScreen.js";
import { PANEL_TITLES, type PanelId, type Screen } from "./screens.js";
import { MenuPanelBody, type MenuData, type MenuId } from "../TopMenu.js";
import { RegionBody, NOTE_HEX, type RegionTab } from "../RegionPanel.js";
import { IncomingWarnings } from "../ArmyPanel.js";
import { RefugeePanel } from "../RefugeePanel.js";
import { ActivityPanel } from "../ActivityPanel.js";
import { TradeRoutesPanel } from "../TradeRoutesPanel.js";
import { ResearchPanel } from "../ResearchPanel.js";
import { Card } from "../ui.js";

export interface PhoneShellProps {
  matchId: string;
  state: MatchStateView;
  screen: Screen;
  push: (s: Screen) => void;
  pop: () => void;
  /** Open a region's screen from anywhere (a warning, the empire list): the stack becomes map → region. */
  openRegion: (id: string) => void;
  setRegionTab: (tab: RegionTab) => void;
  clockOffsetMs: number;
  colorOf: (id: string) => string;
  overlays: Set<string>;
  onToggleOverlay: (id: string) => void;
  target: string | null;
  onPickTarget: (picking: boolean) => void;
  onClearTarget: () => void;
  finished: boolean;
  eliminated: boolean;
  onOpenSummary: () => void;
  menu: MenuData;
}

/** The screens a phone shows over the map. Nothing here is new: each screen wraps the panel the desktop shows elsewhere. */
export function PhoneShell(p: PhoneShellProps) {
  const { screen, pop } = p;
  if (screen.kind === "map") return null;

  if (screen.kind === "region") {
    const region = regionById(screen.id);
    const note = p.state.notes.find((n) => n.regionId === screen.id);
    return (
      <PhoneScreen
        title={region?.name ?? screen.id}
        onBack={pop}
        right={note?.colour ? <span className="inline-block h-3 w-3 rounded-full ring-2 ring-white/70" style={{ background: NOTE_HEX[note.colour] }} title={`Marked ${note.colour}`} /> : undefined}
      >
        <RegionBody
          matchId={p.matchId}
          state={p.state}
          regionId={screen.id}
          clockOffsetMs={p.clockOffsetMs}
          tab={screen.tab}
          onTab={p.setRegionTab}
          target={p.target}
          onPickTarget={p.onPickTarget}
          onClearTarget={p.onClearTarget}
        />
      </PhoneScreen>
    );
  }

  if (screen.kind === "menu") {
    const extras: Array<{ id: PanelId; label: string; badge?: string | number | undefined; tone?: "alert" | undefined }> = [
      { id: "warnings", label: "Alerts", badge: p.state.incoming.length + p.state.refugees.length || undefined, tone: "alert" },
      { id: "activity", label: "Activity" },
      { id: "routes", label: "Trade routes", badge: p.state.routes.length || undefined },
    ];
    const entries = [...extras, ...p.menu.entries.filter((e) => e.id !== "empire")];
    return (
      <PhoneScreen title="Menu" onBack={pop} flush>
        <div className="grid grid-cols-2 gap-2 p-3">
          {entries.map((e) => (
            <button key={e.id} onClick={() => p.push({ kind: "panel", id: e.id })} className="flex min-h-14 items-center justify-between rounded-md border border-slate-700 bg-slate-900 px-3 text-left text-sm text-slate-100 active:bg-slate-800">
              <span>{e.label}</span>
              {e.badge !== undefined && e.badge !== 0 && e.badge !== "" && (
                <span className={`rounded px-1.5 py-0.5 text-xs ${e.tone === "alert" ? "bg-rose-500/30 text-rose-200" : "bg-slate-700 text-slate-300"}`}>{e.badge}</span>
              )}
            </button>
          ))}
        </div>
      </PhoneScreen>
    );
  }

  const id = screen.id;
  const title = PANEL_TITLES[id];
  if (id === "research") {
    return (
      <PhoneScreen title={title} onBack={pop}>
        <ResearchPanel matchId={p.matchId} state={p.state} clockOffsetMs={p.clockOffsetMs} />
      </PhoneScreen>
    );
  }
  if (id === "routes") {
    return (
      <PhoneScreen title={title} onBack={pop}>
        <TradeRoutesPanel matchId={p.matchId} state={p.state} selectedRegionId={null} clockOffsetMs={p.clockOffsetMs} />
      </PhoneScreen>
    );
  }
  if (id === "activity") {
    return (
      <PhoneScreen title={title} onBack={pop}>
        <ActivityPanel matchId={p.matchId} state={p.state} clockOffsetMs={p.clockOffsetMs} onSelect={p.openRegion} />
      </PhoneScreen>
    );
  }
  if (id === "warnings") {
    return (
      <PhoneScreen title={title} onBack={pop}>
        {p.finished && (
          <Card className="border-amber-500/40 bg-amber-500/10 text-sm text-amber-100">
            The match is over.{" "}
            <button className="underline" onClick={p.onOpenSummary}>
              Open the final report
            </button>{" "}
            or{" "}
            <Link to="/match/$matchId/leaderboard" params={{ matchId: p.matchId }} className="underline">
              see the standings
            </Link>
            .
          </Card>
        )}
        {p.eliminated && <Card className="border-slate-600 text-sm text-slate-300">You have no regions left. You can keep watching the match and chat; join the next match from the lobby.</Card>}
        <IncomingWarnings state={p.state} clockOffsetMs={p.clockOffsetMs} onSelect={p.openRegion} />
        <RefugeePanel matchId={p.matchId} state={p.state} clockOffsetMs={p.clockOffsetMs} onSelect={p.openRegion} />
        {p.state.incoming.length === 0 && p.state.refugees.length === 0 && !p.finished && !p.eliminated && <p className="text-sm text-slate-400">Nothing needs you right now. Attacks on the way and migrant columns at your border will show here.</p>}
      </PhoneScreen>
    );
  }
  return (
    <PhoneScreen title={title} onBack={pop} flush>
      <MenuPanelBody
        menu={id as MenuId}
        matchId={p.matchId}
        state={p.state}
        selectedRegionId={null}
        colorOf={p.colorOf}
        overlays={p.overlays}
        onToggleOverlay={p.onToggleOverlay}
        onSelectRegion={p.openRegion}
        clockOffsetMs={p.clockOffsetMs}
        messages={p.menu.messages}
      />
    </PhoneScreen>
  );
}
