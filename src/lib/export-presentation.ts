/**
 * Turns internal payment records into the words an accountant reads.
 *
 * This is the first term-mapping layer in the codebase. `src/api.ts`'s
 * `present*` functions convert units (base units -> dollars); this converts
 * vocabulary. It exists because an accounting export is the most external
 * surface Fuel has — the file leaves the system entirely and lands in a third
 * party's books — so nothing internal should travel in it unexamined.
 *
 * Two rules follow from that, and both are enforced by what this file does NOT
 * export: no crypto identifiers (see 0006), and no raw `payments.detail`, which
 * is protocol-flavoured operator text like "assuming the authorization is
 * spendable" rather than anything an accountant should read.
 *
 * Every function here is pure and total — no throws. An export that dies on one
 * malformed row is worse than one that degrades on that row.
 */

import type { LedgerClass } from "../accounting/rollup.js";
import type { PaymentStatus } from "../db/payments.js";
import type { ReceiptStatus } from "../db/receipts.js";
import { presentReceiptStatus, presentStatus } from "./payment-presentation.js";

/**
 * The counterparty, as a QuickBooks/Xero vendor record would name it.
 *
 * Host, not hostname: the port distinguishes local test endpoints that would
 * otherwise collapse into one vendor. The path is deliberately dropped —
 * paying two endpoints on one host is two purchases from one vendor, not two
 * vendors, and the eventual accounting integration matches vendors by this
 * string.
 *
 * Falls back to the raw value if the URL will not parse, so a bad row exports
 * as something a human can still recognise rather than as an empty cell.
 */
export function vendorFromResourceUrl(resourceUrl: string): string {
  try {
    return new URL(resourceUrl).host || resourceUrl;
  } catch {
    return resourceUrl;
  }
}

/**
 * What the row is, in words — deliberately generic.
 *
 * This used to return `${url.pathname}${url.search}`, and the query string was
 * a real leak. A paid endpoint can carry a credential in its URL
 * (`?api_key=…`, a signed token, a session id), and this column is written into
 * a CSV that leaves Fuel permanently and lands in a third party's books. ADR
 * 0006 already settles the principle: an export is a stronger surface than a
 * screen, so the rule applies to it more, not less.
 *
 * The path went too, and that is the harder call. `/v1/scrape` is useful and
 * harmless; `/services/T000/B000/xoxb-…` is a secret in path form, and nothing
 * here can tell the two apart without a heuristic that will eventually be
 * wrong in the direction that writes a credential into a customer's ledger.
 *
 * What is lost is per-purchase granularity in one column. What replaces it is
 * already in the file: the Vendor column names the counterparty and the
 * Reference column carries the Fuel payment id, which 0006 names as the
 * reconciliation handle. Anyone needing the exact resource opens that payment
 * in Fuel.
 */
export const GENERIC_DESCRIPTION = "Agent API payment";

export function descriptionFromResourceUrl(_resourceUrl: string): string {
  return GENERIC_DESCRIPTION;
}

/**
 * Internal status -> the phrase that goes in the file.
 *
 * The table itself now lives in ./payment-presentation.ts, which is the single
 * owner of this vocabulary for every surface. This function stays because the
 * export's needs are narrower — it wants a string, not a tone — and because
 * naming it here keeps the CSV's dependency on that contract explicit.
 *
 * The strings are unchanged and pinned by a regression test: "unreconciled" is
 * engineering jargon for a real and unusual accounting situation, and
 * "Awaiting confirmation" says it without claiming the money moved or implying
 * it did not.
 */
export function ledgerStatus(status: PaymentStatus): string {
  return presentStatus(status).label;
}

/**
 * The same column, for a row that may be either kind.
 *
 * Dispatching on the source kind rather than on the status VALUE. The two
 * vocabularies overlap — `settled` is a member of both — so a function that
 * looked the string up in one table and fell back to the other would resolve a
 * settled receipt through the payment table and label it "Paid" in a revenue
 * row. Which is backwards: nobody paid, someone was paid.
 */
export function ledgerStatusFor(
  sourceKind: "payment" | "receipt",
  status: PaymentStatus | ReceiptStatus,
): string {
  return sourceKind === "receipt"
    ? presentReceiptStatus(status as ReceiptStatus).label
    : presentStatus(status as PaymentStatus).label;
}

/** The date column: a calendar day in UTC, from an ISO timestamp. */
export function ledgerDay(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/**
 * The account a rolled-up posting line lands in.
 *
 * Two accounts, because a posted line answers a different question from a
 * transaction row. `ledgerStatus` above describes what happened to one payment;
 * this names where an aggregate of them belongs in a chart of accounts.
 *
 * "Suspense" is the standard accounting home for an amount that is real but
 * whose final classification is not yet known — which is exactly an
 * `unreconciled` payment: signed, so the authorization is spendable, but never
 * confirmed. Booking it as an ordinary expense would assert money moved when
 * Fuel does not know that; leaving it out would hide a real exposure. See
 * docs/decisions/0007-accounting-integration-posting-model.md.
 *
 * These are labels, not a configured chart of accounts. Mapping them onto real
 * QuickBooks/Xero accounts is the integration slice's job, and 0007 settles
 * that it starts as one operator-configured default account rather than a
 * per-vendor mapping.
 */
/*
 * TYPED AS LedgerClass, NOT AS AN INLINE UNION, AND THAT IS THE WHOLE POINT.
 *
 * This used to read `Record<"expense" | "suspense", string>` with a
 * `?? "Unknown"` fallback. Widening LedgerClass produced NO compile error
 * here — an inline union is a separate type that merely happened to match —
 * so the first revenue row would have written the word "Unknown" into an
 * accounting CSV, silently, with every type check passing. The fallback made
 * it worse by turning a missing case into a plausible-looking string instead
 * of a crash.
 *
 * Referencing LedgerClass means the compiler now names this file the moment
 * a class is added. The fallback is gone: the Record is total over the union,
 * so there is nothing left for it to catch. See 0012.
 */
const LEDGER_ACCOUNT: Record<LedgerClass, string> = {
  expense: "Agent API Expenses",
  suspense: "Suspense - Unconfirmed Agent Payments",
  revenue: "Agent API Revenue",
};

export function ledgerAccount(ledgerClass: LedgerClass): string {
  return LEDGER_ACCOUNT[ledgerClass];
}
