import { isBenignBrowserNotice, isBrowserExtensionNoise } from "@lastthaw/shared";
import { APP_VERSION } from "./version.js";

/**
 * Anything that breaks in the browser is reported to the server so it shows up in the nightly logs:
 * uncaught errors, promises nobody caught, a screen that crashed while rendering, a request that came
 * back 5xx or with a body the client could not read. Reports are deduplicated per page load and capped,
 * so a broken page cannot flood the server, and a failure to report is swallowed.
 */
export type ClientErrorKind = "error" | "rejection" | "render" | "api" | "schema";

const seen = new Set<string>();
let sent = 0;
const MAX_PER_PAGE = 20;

export function reportClientError(kind: ClientErrorKind, err: unknown, extra: { request?: string; status?: number } = {}): void {
  try {
    const e = err as { message?: unknown; stack?: unknown } | null;
    const message = (typeof e?.message === "string" && e.message) || (typeof err === "string" ? err : String(err ?? "unknown error"));
    if (isBrowserExtensionNoise(message, typeof e?.stack === "string" ? e.stack : null) || isBenignBrowserNotice(message)) return;
    const key = `${kind}:${message}:${extra.request ?? ""}`;
    if (seen.has(key) || sent >= MAX_PER_PAGE) return;
    seen.add(key);
    sent += 1;
    const body = JSON.stringify({
      kind,
      message: message.slice(0, 1000),
      stack: typeof e?.stack === "string" ? e.stack.slice(0, 4000) : undefined,
      url: location.href.slice(0, 500),
      request: extra.request?.slice(0, 300),
      status: extra.status,
      version: APP_VERSION,
      userAgent: navigator.userAgent.slice(0, 300),
    });
    // keepalive lets the report leave even when the page is going away (a reload after a crash).
    void fetch("/api/client-errors", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {
    // Reporting must never make things worse.
  }
}

/** Hook the window's own error events once. */
export function installErrorReporting(): void {
  window.addEventListener("error", (ev) => {
    // Resource load failures (a script or image that did not load) carry no error; report the element instead.
    if (ev.error) reportClientError("error", ev.error);
    else if (ev.message) reportClientError("error", ev.message);
  });
  window.addEventListener("unhandledrejection", (ev) => reportClientError("rejection", ev.reason));
}
