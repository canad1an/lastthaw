import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

const SITE = "Last Thaw";
const ORIGIN = "https://lastthaw.com";
const DEFAULT_DESCRIPTION = "A free 30-day browser strategy game on a freezing Earth. Grow five settlers into an empire on a real map before the ice reaches you.";

function setMeta(selector: string, attrs: Record<string, string>) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = document.createElement(selector.startsWith("link") ? "link" : "meta");
    for (const [k, v] of Object.entries(attrs)) if (k !== "content" && k !== "href") el.setAttribute(k, v);
    document.head.appendChild(el);
  }
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
}

/**
 * Every page names itself: a unique title and description, the canonical
 * address, the same for sharing cards, and noindex for the pages that are
 * nobody's business but the player's. Call it once at the top of a page.
 */
export function usePageMeta(meta: { title: string; description?: string | undefined; path?: string | undefined; noindex?: boolean | undefined }) {
  const { title, description = DEFAULT_DESCRIPTION, path, noindex = false } = meta;
  useEffect(() => {
    const full = title === SITE ? `${SITE}: build before the ice does` : `${title} | ${SITE}`;
    document.title = full;
    const url = `${ORIGIN}${path ?? window.location.pathname}`;
    setMeta('meta[name="description"]', { name: "description", content: description });
    setMeta('meta[property="og:title"]', { property: "og:title", content: full });
    setMeta('meta[property="og:description"]', { property: "og:description", content: description });
    setMeta('meta[property="og:url"]', { property: "og:url", content: url });
    setMeta('meta[property="og:type"]', { property: "og:type", content: "website" });
    setMeta('meta[name="twitter:card"]', { name: "twitter:card", content: "summary" });
    setMeta('meta[name="twitter:title"]', { name: "twitter:title", content: full });
    setMeta('meta[name="twitter:description"]', { name: "twitter:description", content: description });
    setMeta('link[rel="canonical"]', { rel: "canonical", href: url });
    setMeta('meta[name="robots"]', { name: "robots", content: noindex ? "noindex, nofollow" : "index, follow" });
  }, [title, description, path, noindex]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An old UUID address is swapped for the readable one as soon as the match is known, so links and crawlers settle on one URL. */
export function useSlugAddress(matchId: string, slug: string | null | undefined, suffix: "" | "/lobby" | "/leaderboard" | "/report" | "/replay") {
  const nav = useNavigate();
  useEffect(() => {
    if (!slug || slug === matchId || !UUID.test(matchId)) return;
    void nav({ to: `/match/$matchId${suffix}` as "/match/$matchId", params: { matchId: slug }, replace: true });
  }, [matchId, slug, suffix, nav]);
}
