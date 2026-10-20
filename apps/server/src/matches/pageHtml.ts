import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { existsSync, readFileSync, statSync } from "node:fs";
import { balance } from "@lastthaw/shared";
import type { Db } from "../db/client.js";
import { matchRegions, matches, players } from "../db/schema.js";
import { resolveMatchRef } from "./slug.js";
import { buildStory } from "./story.js";
import { config } from "../config.js";

/**
 * Match pages are served with their own title, description, sharing card and structured data already in the
 * HTML, so search engines and link previews see the match, not the site's generic card. The app's own meta
 * code then takes over in the browser and keeps the same words.
 *
 * The built site is read from WEB_DIST (the volume the web image publishes to); without it, there is nothing to serve
 * and the route stays out of the way (the dev server serves pages itself).
 */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let cachedIndex: { path: string; mtime: number; html: string } | null = null;
function indexHtml(): string | null {
  const dir = process.env.WEB_DIST ?? "/srv/web";
  const file = `${dir}/index.html`;
  try {
    if (!existsSync(file)) return null;
    const mtime = statSync(file).mtimeMs;
    if (!cachedIndex || cachedIndex.path !== file || cachedIndex.mtime !== mtime) cachedIndex = { path: file, mtime, html: readFileSync(file, "utf8") };
    return cachedIndex.html;
  } catch {
    return null;
  }
}

export interface PageMeta {
  title: string;
  description: string;
  url: string;
  noindex: boolean;
  jsonLd?: Record<string, unknown> | undefined;
}

/** Put a page's own words into the built index.html. */
export function injectMeta(html: string, meta: PageMeta): string {
  const title = `${meta.title} | Last Thaw`;
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  out = out.replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(meta.description)}" />`);
  out = out.replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(title)}" />`);
  out = out.replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(meta.description)}" />`);
  const extra = [
    `<meta property="og:url" content="${esc(meta.url)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<link rel="canonical" href="${esc(meta.url)}" />`,
    `<meta name="robots" content="${meta.noindex ? "noindex, nofollow" : "index, follow"}" />`,
    ...(meta.jsonLd ? [`<script type="application/ld+json">${JSON.stringify(meta.jsonLd).replace(/</g, "\\u003c")}</script>`] : []),
  ].join("\n    ");
  return out.replace("</head>", `    ${extra}\n  </head>`);
}

const PAGE_CACHE_MS = 60_000;
const pageCache = new Map<string, { at: number; html: string }>();

export async function matchPageMeta(db: Db, ref: string, page: "report" | "replay" | "leaderboard" | "lobby" | "play"): Promise<PageMeta | null> {
  const id = await resolveMatchRef(db, ref);
  if (!id || id === "bad") return null;
  const [m] = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
  if (!m) return null;
  const site = config().PUBLIC_URL;
  const slug = m.slug ?? m.id;
  const finished = m.status === "finished";
  const url = `${site}/match/${slug}${page === "play" ? "" : `/${page}`}`;
  // A private game is never indexed, whatever its state: its address is only for the people who played it and an admin.
  if (((m.settings ?? {}) as { kind?: string }).kind === "private") {
    return { title: m.name, description: "A private Last Thaw game.", url, noindex: true };
  }
  if (!finished) {
    const when = m.status === "lobby" ? `starts ${m.startsAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "is being fought now";
    return { title: page === "lobby" ? `${m.name}: waiting room` : `${m.name}`, description: `${m.name}, a Last Thaw match, ${when}. Thirty days on a real map with the ice closing in from the poles.`, url, noindex: true };
  }
  const ps = await db.select().from(players).where(and(eq(players.matchId, id), eq(players.hidden, false))).orderBy(desc(players.score));
  // Regions and people per tribe as they stood at the end, the same count the report shows.
  const stats = await db
    .select({ owner: matchRegions.ownerPlayerId, regions: sql<number>`count(*)::int`, pop: sql<number>`coalesce(sum(${matchRegions.popWorkers} + ${matchRegions.popSoldiers} + ${matchRegions.popOccupiers}), 0)::float` })
    .from(matchRegions)
    .where(and(eq(matchRegions.matchId, id), sql`${matchRegions.ownerPlayerId} is not null`, isNull(matchRegions.frozenAt)))
    .groupBy(matchRegions.ownerPlayerId);
  const statBy = new Map(stats.map((x) => [x.owner!, x]));
  const standings = ps.map((p) => ({ id: p.id, name: p.name, score: p.score, regions: statBy.get(p.id)?.regions ?? 0, population: Math.round(statBy.get(p.id)?.pop ?? 0), age: p.age, eliminated: p.eliminatedAt !== null, won: p.id === m.winnerPlayerId }));
  const story = await buildStory(db, m, ps, standings);
  const winner = standings.find((s) => s.won) ?? standings[0];
  const first = story.paragraphs[0] ?? `${m.name}, a finished Last Thaw match.`;
  const description = (first.length > 300 ? `${first.slice(0, 297).trimEnd()}…` : first).replace(/\s+/g, " ");
  const titles = { report: m.winKind === "ended" ? `${m.name}: ended early` : `${m.name}: final report, won by ${winner?.name ?? "nobody"}`, replay: `${m.name}: replay of all ${balance.match.lengthDays} days`, leaderboard: `${m.name}: final standings`, lobby: `${m.name}`, play: `${m.name}` };
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: m.name,
    description,
    startDate: m.startsAt.toISOString(),
    endDate: m.finishedAt?.toISOString() ?? m.endsAt.toISOString(),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
    location: { "@type": "VirtualLocation", url },
    organizer: { "@type": "Organization", name: "Last Thaw", url: site },
    url,
    ...(winner ? { subjectOf: { "@type": "CreativeWork", name: `${m.name}: final report`, url: `${site}/match/${slug}/report`, about: `Won by ${winner.name}` } } : {}),
  };
  return { title: titles[page], description, url, noindex: false, jsonLd };
}

/** Serve the built page for a match address with that match's words in its head. */
export async function matchPageRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  app.get("/match/:ref", async (req, reply) => serve(req.params as { ref: string }, "play", reply));
  app.get("/match/:ref/:page", async (req, reply) => {
    const { ref, page } = req.params as { ref: string; page: string };
    const kind = page === "report" || page === "replay" || page === "leaderboard" || page === "lobby" ? page : null;
    return kind ? serve({ ref }, kind, reply) : serve({ ref }, "play", reply);
  });
  async function serve(params: { ref: string }, page: "report" | "replay" | "leaderboard" | "lobby" | "play", reply: FastifyReply) {
    const html = indexHtml();
    if (!html) return reply.code(404).send({ error: "the site is not built here" });
    const key = `${params.ref}/${page}`;
    const hit = pageCache.get(key);
    if (hit && Date.now() - hit.at < PAGE_CACHE_MS) return reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(hit.html);
    const meta = await matchPageMeta(db, params.ref, page).catch(() => null);
    const out = meta ? injectMeta(html, meta) : html;
    pageCache.set(key, { at: Date.now(), html: out });
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(out);
  }
}
