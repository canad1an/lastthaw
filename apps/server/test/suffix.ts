import { nameProblem } from "@lastthaw/shared";

/**
 * A time-based suffix for test names and emails that the name filter accepts. A raw `Date.now().toString(36)` now and
 * then spells a refused word in leetspeak ("…b7c…", "…nf7…" read as btc, nft: "a name cannot be an advertisement"),
 * and the sign-up in that test fails with a 400 for about one millisecond in a thousand.
 */
export function nameSuffix(): string {
  let t = Date.now();
  while (nameProblem(t.toString(36))) t += 1;
  return t.toString(36);
}
