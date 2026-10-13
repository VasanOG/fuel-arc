/**
 * Dollars <-> integer base units.
 *
 * The product speaks dollars (CLAUDE.md: no crypto terms in the product) and
 * storage speaks integer base units. This is the single place that converts,
 * and it converts via strings rather than floating-point maths — `0.1 + 0.2`
 * is not `0.3` in binary floating point, and a spend cap that drifts by a
 * rounding error is a money bug.
 */

/** USDC has 6 decimals. */
export const DECIMALS = 6;

/**
 * Ceiling on any amount this function will produce.
 *
 * SQLite stores these as int64, so a value above 2^53 binds and persists
 * happily but throws ERR_OUT_OF_RANGE on the way back out — `BigInt(row.cap)`
 * is fine, but node:sqlite hands back a JS number. A single fat-fingered cap
 * ("$9000000000000" for "$9000") would then make every read of that row throw,
 * taking down every route that loads an agent. Refusing it at the edge keeps
 * the blast radius at one 400 response.
 *
 * 2^53 base units is ~$9.007 billion — far above any legitimate cap.
 */
export const MAX_BASE_UNITS = 2n ** 53n;

/**
 * "0.001" or "$0.001" or 0.001 -> 1000n
 *
 * Rejects more precision than the asset can represent rather than silently
 * truncating: someone asking for a $0.0000001 cap has misunderstood something,
 * and rounding it to zero would be worse than telling them.
 */
export function dollarsToBaseUnits(input: string | number): bigint {
  // String(input) would happily coerce ["9000"] or {} into something the regex
  // might accept, so require a primitive before touching it.
  if (typeof input !== "string" && typeof input !== "number") {
    throw new Error(`Not a valid dollar amount: ${JSON.stringify(input)}`);
  }

  const raw = String(input).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`Not a valid dollar amount: ${JSON.stringify(input)}`);
  }

  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > DECIMALS) {
    throw new Error(`Too precise: ${raw} has more than ${DECIMALS} decimal places`);
  }

  const units = BigInt(whole + fraction.padEnd(DECIMALS, "0"));
  if (units > MAX_BASE_UNITS) {
    throw new Error(`Amount too large: ${raw} exceeds the maximum of ${MAX_BASE_UNITS} base units`);
  }
  return units;
}

/**
 * 1000n -> "0.001000", 1500000n -> "1.500000"
 *
 * Always exactly DECIMALS places. `baseUnitsToDollars` strips trailing zeros,
 * which reads well in a UI ("$1.5") but is wrong in a column an accountant
 * sums or a spreadsheet infers a type from — a mix of "1.5" and "0.001000" in
 * one column is ragged, and "1" looks like an integer count rather than a
 * dollar amount.
 *
 * A separate function rather than an option on the existing one: spend caps
 * and the dashboard read baseUnitsToDollars, and this slice has no business
 * changing what they render.
 */
export function baseUnitsToDollarsFixed(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const divisor = 10n ** BigInt(DECIMALS);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * 30000n -> "0.03". Two decimal places, the precision accounting systems store.
 *
 * ONLY for amounts that are already whole cents — rolled-up posting lines,
 * which src/accounting/rollup.ts guarantees are exact multiples of a cent. It
 * is not a general-purpose formatter, and calling it on a raw payment amount
 * would be the exact mistake this project exists to avoid: $0.001 is not $0.00.
 *
 * When handed a value that is NOT a whole cent it degrades to full precision
 * rather than rounding, and rather than throwing. Rounding would silently
 * misstate money, which is the failure this whole slice is built to prevent.
 * Throwing would take down an export over one bad row. Emitting a visibly
 * ragged "0.0015" in a column of "0.03" values does neither: nothing is
 * misreported, and the anomaly is obvious to whoever opens the file.
 */
export function baseUnitsToWholeCents(units: bigint): string {
  const centSize = 10n ** BigInt(DECIMALS) / 100n;
  if (units % centSize !== 0n) return baseUnitsToDollarsFixed(units);

  const negative = units < 0n;
  const abs = negative ? -units : units;
  const cents = abs / centSize;
  return `${negative ? "-" : ""}${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** 1000n -> "0.001" */
export function baseUnitsToDollars(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const divisor = 10n ** BigInt(DECIMALS);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
