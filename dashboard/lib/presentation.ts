/**
 * What is left of the dashboard's presentation layer.
 *
 * This file used to restate the payment-status vocabulary that
 * src/lib/export-presentation.ts owned — a hand-copied second table that
 * nothing kept in step. 5B-2 moved that vocabulary to
 * src/lib/payment-presentation.ts, made it the single owner for every surface,
 * and had the API return the label and tone with each payment. The dashboard
 * now renders what the server says a status means and no longer decides for
 * itself.
 *
 * `vendorHost` went the same way. It parsed a full resource URL in the browser
 * tier; the API now returns the vendor host alone, and the URL — which can
 * carry a credential in its path or its query — never leaves the server.
 *
 * What remains is date formatting, which is display, not vocabulary.
 */

/**
 * Mirrors the backend's tone union. A TYPE, not a table: it says which values
 * can arrive, and the backend decides which one does.
 */
export type Tone = "good" | "watch" | "bad" | "quiet";

/** Dates render as plain ISO days: unambiguous, sortable, no locale surprises. */
export function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

/**
 * "-1.184" -> "\u2212$1.184", "0.05" -> "$0.05".
 *
 * The sign moves OUTSIDE the dollar mark, because "$-1.18" reads as a broken
 * template and "\u22121.18" with no currency reads as a count. A true minus
 * (U+2212), not a hyphen, for the same reason the ledger's amount column uses
 * one: at this size a hyphen is too short to register as a sign, and a negative
 * net that reads as positive is the one error this figure must not make.
 *
 * Purely presentational — it never parses the number or does arithmetic on it.
 * The API owns the single conversion from base units to dollars, and two places
 * doing that arithmetic is two places that can round differently.
 */
export function signedUsd(amount: string): string {
  return amount.startsWith("-") ? `\u2212$${amount.slice(1)}` : `$${amount}`;
}
