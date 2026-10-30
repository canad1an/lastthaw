/**
 * Which economy rules a match plays by. 1: the original rules (techs multiply building yields, people only eat).
 * 2: tech yields add to building yields, and what each person uses rises with every age entered. A match's rules are
 * fixed when it is created (settings.economy), so a running game never changes underfoot. The server resolves the rules
 * of the match in scope; anything unscoped reads rules 1.
 */
export const ECONOMY_RULES_LATEST = 2;

let resolver: () => number = () => 1;

export function setEconomyRulesResolver(fn: () => number): void {
  resolver = fn;
}

export function economyRules(): number {
  return resolver();
}
