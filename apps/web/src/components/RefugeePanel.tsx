import { useMutation, useQueryClient } from "@tanstack/react-query";
import { regionById, formatCountdown, type MatchStateView } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { useNow } from "../hooks/useNow.js";
import { Button, Card, ErrorText, fmt } from "./ui.js";

/** Migrant columns waiting at the border: take them in for food, or turn them away. */
export function RefugeePanel({ matchId, state, clockOffsetMs, onSelect }: { matchId: string; state: MatchStateView; clockOffsetMs: number; onSelect: (regionId: string) => void }) {
  const qc = useQueryClient();
  const now = useNow(1000);
  const decide = useMutation({
    mutationFn: (v: { offerId: string; accept: boolean }) => api.decideRefugees(matchId, v.offerId, v.accept),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.matchState(matchId) }),
  });
  if (state.refugees.length === 0) return null;
  return (
    <Card className="border-amber-500/50 bg-amber-500/10">
      <h2 className="mb-1 text-sm font-medium text-amber-200">People at the border</h2>
      <ul className="space-y-2 text-sm">
        {state.refugees.map((o) => {
          const region = state.owned.find((r) => r.regionId === o.regionId);
          const left = (Date.parse(o.expiresAt) - (now + clockOffsetMs)) / 1000;
          return (
            <li key={o.id} className="space-y-1">
              <button className="text-left text-amber-100 hover:underline" onClick={() => onSelect(o.regionId)}>
                {fmt(o.people)} people fleeing {regionById(o.fromRegionId)?.name ?? "the ice"} wait outside {regionById(o.regionId)?.name ?? o.regionId}
              </button>
              <p className="text-xs text-amber-200/80">
                Taking them in costs {fmt(o.food)} food{region ? ` (${fmt(region.food)} here)` : ""} and adds them as workers. They move on in {formatCountdown(Math.max(0, left))}.
              </p>
              <div className="flex gap-2">
                <Button className="px-3 py-1 text-xs" disabled={decide.isPending} onClick={() => decide.mutate({ offerId: o.id, accept: true })}>
                  Take them in
                </Button>
                <Button variant="ghost" className="px-3 py-1 text-xs" disabled={decide.isPending} onClick={() => decide.mutate({ offerId: o.id, accept: false })}>
                  Turn them away
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <ErrorText>{decide.error?.message}</ErrorText>
    </Card>
  );
}
