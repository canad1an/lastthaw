/**
 * Funnel events for Matomo (stats.lastthaw.com): signed up, confirmed email, joined or registered for a match.
 * Matomo ties each event to the visit's referrer and any utm_ / mtm_ campaign tags on the landing URL, so its
 * Events report, segmented by channel, shows which outreach brings players who actually play. A no-op off lastthaw.com.
 */
export function trackFunnel(action: "Signed up" | "Confirmed email" | "Joined match" | "Registered for tournament", name?: string): void {
  const paq = (window as unknown as { _paq?: unknown[][] })._paq;
  if (!paq) return;
  paq.push(name ? ["trackEvent", "Funnel", action, name] : ["trackEvent", "Funnel", action]);
}
