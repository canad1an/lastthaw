/**
 * A page left open across a deploy runs the old bundle against the new server. When the server adds
 * a value the old schemas do not know (an army status, a mission), every poll fails to parse and the
 * screen is stuck until the player reloads. The client then asks the server for its version and
 * reloads itself once, but only when the versions really differ and it has not already reloaded for
 * that server version (a schema bug in the current build must not loop the page).
 */
export function shouldReloadForNewVersion(clientVersion: string, serverVersion: string | null | undefined, alreadyReloadedFor: string | null): boolean {
  if (!serverVersion || serverVersion === clientVersion) return false;
  return alreadyReloadedFor !== serverVersion;
}

/**
 * Errors thrown by a browser extension inside our page (a Safari or Chrome extension messaging its own
 * background page) are not ours to fix and would only bury real client errors in the nightly logs.
 */
export function isBrowserExtensionNoise(message: string, stack?: string | null): boolean {
  if (/(chrome|moz|safari(-web)?)-extension:\/\//.test(stack ?? "") || /(chrome|moz|safari(-web)?)-extension:\/\//.test(message)) return true;
  return /\bruntime\.sendMessage\b|Extension context invalidated/.test(message);
}
