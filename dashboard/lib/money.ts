/**
 * Dollar arithmetic for the dashboard.
 *
 * The Fuel API sends every amount as a decimal STRING, never a number, because
 * the backend holds base units as bigint and formats at the edge. This file
 * exists so the dashboard can compare and proportion those amounts without ever
 * turning one into a float.
 *
 * Nothing here formats money for display. Display uses the API's own string
 * verbatim, so what an operator reads is exactly what the backend computed and
 * there is no second formatter to drift.
 */

/** USDC's precision, and therefore the API's. */
const DECIMALS = 6;
const SCALE = 10n ** BigInt(DECIMALS);

/**
 * Parses a dollar string into micro-dollars.
 *
 * Extra fractional digits are truncated rather than rounded, matching the
 * backend's truncation-toward-zero discipline (see the warning in
 * src/accounting/rollup.ts against "fixing" that to floor).
 */
export function parseUsd(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`not a dollar amount: ${JSON.stringify(value)}`);
  const [, sign, whole, fraction = ""] = match;
  const micro = BigInt(whole) * SCALE + BigInt(fraction.slice(0, DECIMALS).padEnd(DECIMALS, "0"));
  return sign === "-" ? -micro : micro;
}

/** True when the agent or team has spent everything it was allowed. */
export function isExhausted(remaining: string): boolean {
  return parseUsd(remaining) <= 0n;
}

/**
 * True when spend has passed the ceiling.
 *
 * This is a real state, not an error: an approved payment can push spend past a
 * cap, and `src/db/approvals.ts` says so explicitly — "spent <= cap is not an
 * invariant". Every overage traces to a named approval, which is the whole
 * point of showing it rather than clamping it.
 */
export function isOverAuthority(spent: string, cap: string): boolean {
  return parseUsd(spent) > parseUsd(cap);
}

/**
 * What proportion of the cap has been spent, as a percentage.
 *
 * Returns null when the cap is zero — an agent with no authority has not used
 * "100%" of it, it has no denominator, and saying 100% would read as "fully
 * used" rather than "none granted". Can exceed 100 (see isOverAuthority).
 */
export function percentUsed(spent: string, cap: string): number | null {
  const capMicro = parseUsd(cap);
  if (capMicro <= 0n) return null;
  return Number((parseUsd(spent) * 10_000n) / capMicro) / 100;
}
