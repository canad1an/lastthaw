import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { MAP_IDS, MAP_NAMES, type MapId } from "@lastthaw/shared";
import { usePageMeta } from "../seo.js";
import { Button, Card, Input } from "../components/ui.js";

export interface PastMatch {
  id: string;
  slug: string;
  name: string;
  speed: number;
  startsAt: string;
  finishedAt: string | null;
  winnerName: string | null;
  winKind: string | null;
  kind: string;
  map: MapId;
  humans: number;
  players: number;
}

export interface PastMatchesPage {
  matches: PastMatch[];
  total: number;
  page: number;
  pages: number;
}

export interface PastSearch {
  q?: string;
  map?: MapId;
  kind?: "tournament" | "public";
  page?: number;
}

export const PAGE_SIZE = 20;

/** The search parameters of the archive address, cleaned. */
export function pastSearch(s: Record<string, unknown>): PastSearch {
  const out: PastSearch = {};
  if (typeof s.q === "string" && s.q.trim()) out.q = s.q.trim().slice(0, 60);
  if (typeof s.map === "string" && (MAP_IDS as readonly string[]).includes(s.map)) out.map = s.map as MapId;
  if (s.kind === "tournament" || s.kind === "public") out.kind = s.kind;
  const page = Number(s.page);
  if (Number.isInteger(page) && page > 1) out.page = page;
  return out;
}

export function pastQuery(s: PastSearch): string {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.map) p.set("map", s.map);
  if (s.kind) p.set("kind", s.kind);
  if (s.page && s.page > 1) p.set("page", String(s.page));
  const str = p.toString();
  return str ? `?${str}` : "";
}

export const howWon = (k: string | null) => (k === "hold" ? "held 60% of the world" : k === "wonder" ? "finished the Great Hearth" : k === "survival" ? "outlasted the ice" : k === "score" ? "highest score" : k === "ended" ? "ended early" : "");

/** One finished match in a list: name, kind, speed, map, when, who won, and the report and replay. */
export function PastMatchRow({ m }: { m: PastMatch }) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="font-medium text-slate-100">
          <Link to="/match/$matchId/report" params={{ matchId: m.slug || m.id }} className="hover:underline">
            {m.name}
          </Link>{" "}
          <span className="text-xs text-slate-500">
            · {m.kind === "tournament" ? "tournament" : "game"} · {m.speed}x · {MAP_NAMES[m.map] ?? m.map} · {m.players} players
          </span>
        </p>
        <p className="text-sm text-slate-400">
          {m.finishedAt ? new Date(m.finishedAt).toLocaleDateString() : ""}
          {m.winnerName ? (
            <>
              {" "}· <span className="text-amber-200">{m.winnerName}</span> won{howWon(m.winKind) ? `: ${howWon(m.winKind)}` : ""}
            </>
          ) : m.winKind === "ended" ? (
            " · ended early, no winner"
          ) : null}
        </p>
      </div>
      <div className="flex gap-2">
        <Link to="/match/$matchId/replay" params={{ matchId: m.slug || m.id }}>
          <Button variant="ghost">▶ Replay</Button>
        </Link>
        <Link to="/match/$matchId/report" params={{ matchId: m.slug || m.id }}>
          <Button variant="ghost">Review</Button>
        </Link>
      </div>
    </Card>
  );
}

/** Every finished public match, searchable by name or player, map and kind, twenty to a page. */
export function PastMatchesPage() {
  const search = useSearch({ from: "/matches/past" }) as PastSearch;
  const nav = useNavigate();
  const page = search.page ?? 1;
  const filtered = !!(search.q || search.map || search.kind);
  usePageMeta({
    title: page > 1 ? `Past matches, page ${page}` : "Past matches",
    description: "Every finished Last Thaw match: tournaments and games on Earth and Pangaea, who won and how, each with its written report and a thirty-second replay. Search by match or player name.",
    path: `/matches/past${pastQuery(search.page ? { page: search.page } : {})}`,
    noindex: filtered,
  });
  const [q, setQ] = useState(search.q ?? "");
  const [map, setMap] = useState<MapId | "">(search.map ?? "");
  const [kind, setKind] = useState<"tournament" | "public" | "">(search.kind ?? "");
  const results = useQuery({
    queryKey: ["past-matches", search],
    queryFn: () => fetch(`/api/matches/past${pastQuery(search)}`, { credentials: "include" }).then((r) => r.json() as Promise<PastMatchesPage>),
    placeholderData: (prev) => prev,
  });
  const go = (next: PastSearch) => void nav({ to: "/matches/past", search: next as never });
  const data = results.data;
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-400">The archive</p>
        <h1 className="display text-3xl font-semibold text-white">Past matches</h1>
        <p className="mt-1 text-sm text-slate-400">Every finished tournament and game, newest first, with its report and replay. Search by match or player name, or narrow it to a map or a kind.</p>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          go(pastSearch({ q, map, kind }));
        }}
      >
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Match or player name" aria-label="Match or player name" />
        <select value={map} onChange={(e) => setMap(e.target.value as MapId | "")} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" aria-label="Map">
          <option value="">Any map</option>
          {MAP_IDS.map((id) => (
            <option key={id} value={id}>
              {MAP_NAMES[id]}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as "tournament" | "public" | "")} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" aria-label="Kind">
          <option value="">Tournaments and games</option>
          <option value="tournament">Tournaments</option>
          <option value="public">Games</option>
        </select>
        <Button type="submit">Search</Button>
      </form>
      {results.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {data && (
        <>
          <p className="text-sm text-slate-400">
            {data.total === 0 ? "No finished matches match that." : `${data.total} ${data.total === 1 ? "match" : "matches"}${data.pages > 1 ? `, page ${data.page} of ${data.pages}` : ""}.`}
            {filtered && (
              <>
                {" "}
                <button className="text-sky-300 hover:underline" onClick={() => { setQ(""); setMap(""); setKind(""); go({}); }}>
                  Show all
                </button>
              </>
            )}
          </p>
          <div className="space-y-2">
            {data.matches.map((m) => (
              <PastMatchRow key={m.id} m={m} />
            ))}
          </div>
          {data.pages > 1 && (
            <nav className="flex items-center justify-between text-sm" aria-label="Pages">
              {data.page > 1 ? (
                <Link to="/matches/past" search={{ ...search, page: data.page - 1 > 1 ? data.page - 1 : undefined } as never} className="text-sky-300 hover:underline">
                  ← Newer
                </Link>
              ) : (
                <span />
              )}
              <span className="text-slate-500">
                Page {data.page} of {data.pages}
              </span>
              {data.page < data.pages ? (
                <Link to="/matches/past" search={{ ...search, page: data.page + 1 } as never} className="text-sky-300 hover:underline">
                  Older →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </main>
  );
}
