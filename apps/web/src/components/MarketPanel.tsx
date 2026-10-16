import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { regionById, tradeResource, type MatchStateView, type TradeResource } from "@lastthaw/shared";
import { api, keys } from "../api/client.js";
import { Button, Card, ErrorText, Field, Input, fmt } from "./ui.js";

const RESOURCES = tradeResource.options;

/** The market: open offers from everyone, my offers, and a form to post one. */
export function MarketPanel({ matchId, state, selectedRegionId }: { matchId: string; state: MatchStateView; selectedRegionId: string | null }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.market(matchId), queryFn: () => api.market(matchId), refetchInterval: 30_000 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.market(matchId) });
    void qc.invalidateQueries({ queryKey: keys.matchState(matchId) });
  };
  const ownedIds = state.owned.map((o) => o.regionId);
  const defaultRegion = (selectedRegionId && ownedIds.includes(selectedRegionId) ? selectedRegionId : null) ?? state.me.capitalRegionId ?? ownedIds[0] ?? "";

  const [open, setOpen] = useState(false);
  const [regionId, setRegionId] = useState<string>(defaultRegion);
  const [offerResource, setOfferResource] = useState<TradeResource>("wood");
  const [offerAmount, setOfferAmount] = useState("100");
  const [askResource, setAskResource] = useState<TradeResource>("stone");
  const [askAmount, setAskAmount] = useState("50");

  const post = useMutation({
    mutationFn: () => api.postOrder(matchId, { regionId: regionId || defaultRegion, offerResource, offerAmount: Number(offerAmount), askResource, askAmount: Number(askAmount) }),
    onSuccess: refresh,
  });
  const cancel = useMutation({ mutationFn: (orderId: string) => api.cancelOrder(matchId, orderId), onSuccess: refresh });
  const accept = useMutation({ mutationFn: (orderId: string) => api.acceptOrder(matchId, orderId, defaultRegion), onSuccess: refresh });

  const others = (q.data?.open ?? []).filter((o) => o.playerId !== state.me.playerId);
  const mine = q.data?.mine ?? [];
  const regionName = (id: string) => regionById(id)?.name ?? id;

  return (
    <Card className="space-y-2">
      <button className="flex w-full items-center justify-between text-sm font-medium" onClick={() => setOpen((o) => !o)}>
        <span>Market</span>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
          {others.length + mine.filter((o) => o.status === "open").length} offers{mine.some((o) => o.status === "open") ? ` (${mine.filter((o) => o.status === "open").length} mine)` : ""}
        </span>
      </button>
      {open && (
        <div className="space-y-3">
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Open offers</h3>
            {others.length === 0 && <p className="text-sm text-slate-500">Nobody is selling right now.</p>}
            <ul className="space-y-1 text-sm">
              {others.map((o) => (
                <li key={o.id} className="flex items-center gap-2 rounded bg-slate-950/60 px-2 py-1 text-slate-300">
                  <span className="flex-1">
                    <span className="text-slate-200">{o.playerName}</span> offers {fmt(o.offerAmount)} {o.offerResource} for {fmt(o.askAmount)} {o.askResource}
                  </span>
                  <Button className="px-2 py-1 text-xs" onClick={() => accept.mutate(o.id)} disabled={accept.isPending || !defaultRegion}>
                    Accept
                  </Button>
                </li>
              ))}
            </ul>
            {defaultRegion && others.length > 0 && <p className="mt-1 text-xs text-slate-500">Accepting pays from and delivers to {regionName(defaultRegion)}.</p>}
            <ErrorText>{accept.error?.message}</ErrorText>
          </div>

          {mine.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">My offers</h3>
              <ul className="space-y-1 text-sm">
                {mine.map((o) => (
                  <li key={o.id} className="flex items-center gap-2 rounded bg-slate-950/60 px-2 py-1 text-slate-300">
                    <span className="flex-1">
                      {fmt(o.offerAmount)} {o.offerResource} for {fmt(o.askAmount)} {o.askResource}
                      <span className="ml-2 text-xs text-slate-500">
                        {o.regionId ? regionName(o.regionId) : "your region"} · {o.status}
                      </span>
                    </span>
                    {o.status === "open" && (
                      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => cancel.mutate(o.id)} disabled={cancel.isPending}>
                        Cancel
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <ErrorText>{cancel.error?.message}</ErrorText>
            </div>
          )}

          <form
            className="space-y-2 border-t border-slate-800 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              post.mutate();
            }}
          >
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">Post an offer</h3>
            <Field label="From region">
              <select className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100" value={regionId || defaultRegion} onChange={(e) => setRegionId(e.target.value)}>
                {state.owned.map((o) => (
                  <option key={o.regionId} value={o.regionId}>
                    {regionName(o.regionId)}
                    {o.isCapital ? " (capital)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="I give">
                <select className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100" value={offerResource} onChange={(e) => setOfferResource(e.target.value as TradeResource)}>
                  {RESOURCES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Amount">
                <Input type="number" min={1} step={1} value={offerAmount} onChange={(e) => setOfferAmount(e.target.value)} />
              </Field>
              <Field label="I want">
                <select className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100" value={askResource} onChange={(e) => setAskResource(e.target.value as TradeResource)}>
                  {RESOURCES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Amount">
                <Input type="number" min={1} step={1} value={askAmount} onChange={(e) => setAskAmount(e.target.value)} />
              </Field>
            </div>
            <Button type="submit" disabled={post.isPending || !(Number(offerAmount) > 0) || !(Number(askAmount) > 0) || offerResource === askResource || !state.owned.length}>
              Post offer
            </Button>
            <ErrorText>{post.error?.message}</ErrorText>
          </form>
        </div>
      )}
    </Card>
  );
}
