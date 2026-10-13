/**
 * How sub-cent spend becomes a postable accounting line.
 *
 * The problem this exists to solve: every payment Fuel has made is $0.001, and
 * QuickBooks and Xero store two decimal places. Posted one-to-one, each of them
 * rounds to $0.00 — a ledger of nothing. See
 * docs/decisions/0007-accounting-integration-posting-model.md.
 *
 * So spend accumulates per (agent, vendor, class) until it crosses a whole cent,
 * and only the whole-cent part is posted. The remainder carries forward. This
 * module is the arithmetic of that split, and nothing else.
 *
 * The rules themselves, kept pure — no database, no clock, no money. Same shape
 * as anomaly.ts and velocity.ts, and for the same reason: the numbers here end
 * up in someone's real books, so they must be exercisable without a database, a
 * posting run, or a payment.
 *
 * NOTE ON UNITS. Everything here is integer base units. USDC has 6 decimals, so
 * one cent is 10,000 base units and a typical $0.001 payment is 1,000 — a tenth
 * of a cent. Never use floating point in this file: `0.1 + 0.2 !== 0.3`, and a
 * ledger that drifts by a rounding error is a money bug (see lib/money.ts).
 */

import { DECIMALS } from "../lib/money.js";
import type { PaymentStatus } from "../db/payments.js";

/**
 * One cent, in base units. The smallest amount an accounting system can hold.
 *
 * Derived from DECIMALS rather than written as a literal so it cannot drift if
 * the asset's precision ever changes: 10^6 base units per dollar / 100 cents.
 */
export const CENT_BASE_UNITS = 10n ** BigInt(DECIMALS) / 100n;

/**
 * Which account a line belongs to.
 *
 * `expense` and `suspense` exactly partition APPEARS_IN_LEDGER
 * (src/db/payments.ts): a `settled` payment is an expense, an `unreconciled`
 * one sits in suspense because Fuel genuinely does not know whether the money
 * moved — it was signed, so the authorization is spendable, but no settlement
 * was ever seen. Booking that as a paid expense would overstate spend;
 * omitting it would hide a real exposure. A suspense account is the standard
 * accounting answer to exactly that, and 0007 explains the reasoning at length.
 *
 * That partition is what makes reclassification free. A payment moving
 * `unreconciled -> settled` simply changes which bucket it is owed to; the
 * suspense bucket then owes less than it has already posted, and the next run
 * emits the credit automatically. There is no separate reclass path.
 *
 * `revenue` partitions nothing in `payments`, because it does not come from
 * there — it comes from `receipts`, money Fuel witnessed arriving. It is the
 * one class whose source is a different table, which is why the integrity
 * checks in db/postings.ts are split per direction rather than summing across
 * classes: an error in one direction must not be able to hide behind an error
 * in the other. See 0012.
 *
 * THERE IS DELIBERATELY NO REVENUE-SUSPENSE. Outbound suspense exists because
 * recording an uncertain payment is the cautious move — the exposure is real
 * and hiding it would understate what is owed. Inbound inverts every term:
 * when Fuel does not know whether it was paid, recording it is the ADVERSE
 * move, because unconfirmed revenue in a customer's books overstates what they
 * earned. So an unconfirmed receipt does not post at all. It stays fully
 * visible inside Fuel, which is where an operator needs to see it. 0012.
 */
export type LedgerClass = "expense" | "suspense" | "revenue";

/**
 * Which account a payment's spend is currently owed to, or null if it does not
 * belong in the books at all.
 *
 * A Record rather than a switch, matching ledgerStatus in
 * lib/export-presentation.ts, because it is exhaustive over PaymentStatus BY
 * CONSTRUCTION: adding a status to the union without deciding its accounting
 * treatment here is a compile error. That is the point. A status quietly
 * defaulting to "not in the books" is how spend goes missing from a ledger
 * without anyone getting an error.
 *
 * The nulls are deliberate and each has a reason:
 *   pending/signing — in flight. The reaper resolves them within two minutes,
 *                     and booking a transaction that may never happen is worse
 *                     than booking it late. (Note this is exactly where
 *                     APPEARS_IN_LEDGER and COUNTS_AGAINST_CAP diverge: a cap
 *                     must count money that MIGHT move, a ledger reports money
 *                     that DID.)
 *   blocked/failed  — nothing was ever signed, so no money moved.
 */
const LEDGER_CLASS: Record<PaymentStatus, LedgerClass | null> = {
  settled: "expense",
  unreconciled: "suspense",
  pending: null,
  signing: null,
  blocked: null,
  failed: null,
};

export function ledgerClassFor(status: PaymentStatus): LedgerClass | null {
  return LEDGER_CLASS[status] ?? null;
}

/**
 * Every class, for callers that must consider each bucket a line could sit in.
 *
 * Iterate this rather than writing a literal `["expense", "suspense"] as const`
 * in a loop: a literal compiles clean when the union widens and silently stops
 * covering the new member, which is exactly how a class goes unposted with no
 * error anywhere. Same failure mode ledgerAccount had in
 * lib/export-presentation.ts before 0012.
 */
export const LEDGER_CLASSES: LedgerClass[] = ["expense", "suspense", "revenue"];

/**
 * The classes a PAYMENT can be owed to, as their own type.
 *
 * A payment can never be revenue, so anything reading `payments` must iterate
 * this rather than LEDGER_CLASSES — otherwise every payment grows an empty
 * revenue bucket whose "absorbed" figure has no meaning. Narrowing it to a
 * type rather than leaving it a convention means a Record over spend classes
 * will not silently accept a revenue key, and vice versa.
 */
export type SpendClass = Extract<LedgerClass, "expense" | "suspense">;
export const SPEND_CLASSES: SpendClass[] = ["expense", "suspense"];

/** The mirror: the classes a RECEIPT can be owed to. */
export type EarnClass = Extract<LedgerClass, "revenue">;
export const EARN_CLASSES: EarnClass[] = ["revenue"];

/**
 * Which way money moved, as the unit a QuickBooks document is scoped to.
 *
 * Spend and revenue post as SEPARATE JournalEntries rather than one combined
 * document. 0008 makes a posted entry permanent, correctable only by a whole
 * new linked entry — so a combined document with a revenue-mapping error would
 * force re-booking correctly-posted spend just to fix the revenue half. Two
 * documents let each direction be corrected on its own.
 */
export type PostingDirection = "spend" | "earn";
export const POSTING_DIRECTIONS: PostingDirection[] = ["spend", "earn"];

/**
 * The classes a document in this direction may contain.
 *
 * A Record over the full union rather than a function with an `if`, so adding a
 * direction is a compile error here instead of falling through to whichever
 * branch happened to be the else.
 */
export const CLASSES_BY_DIRECTION: Record<PostingDirection, readonly LedgerClass[]> = {
  spend: SPEND_CLASSES,
  earn: EARN_CLASSES,
};

/** The inverse: which document a line belongs in. */
export function directionOf(ledgerClass: LedgerClass): PostingDirection {
  return ledgerClass === "revenue" ? "earn" : "spend";
}

/**
 * Where money comes from for a given class. `payments` for spend, `receipts`
 * for revenue.
 *
 * A function over the class rather than a boolean on the caller, so adding a
 * class forces a decision here instead of defaulting into whichever branch an
 * `if` happened to fall through to.
 */
export function sourceKindFor(ledgerClass: LedgerClass): "payment" | "receipt" {
  return ledgerClass === "revenue" ? "receipt" : "payment";
}

export interface ClearedAmount {
  /** The whole-cent part, ready to post. Always a multiple of CENT_BASE_UNITS. */
  postable: bigint;
  /** The sub-cent remainder, carried to the next run. |carried| < CENT_BASE_UNITS. */
  carried: bigint;
}

/**
 * Splits a residual into the part that can be posted and the part that cannot.
 *
 * THE NEGATIVE CASE IS NOT AN EDGE CASE — it is how reclassification works, and
 * it is the most dangerous arithmetic in this slice. A residual goes negative
 * when a bucket has already posted more than it currently owes, which happens
 * every time an `unreconciled` payment settles: the suspense bucket still shows
 * the posted amount, but no longer owes it. The correction is a negative line,
 * a credit releasing suspense.
 *
 * BigInt division truncates toward zero, which is the behaviour we want in BOTH
 * directions:
 *
 *    +15000n / 10000n === +1n  ->  post   +10000, carry +5000
 *    -15000n / 10000n === -1n  ->  credit -10000, carry -5000
 *
 * Do NOT "fix" this to floor semantics. `Math.floor(-1.5) === -2`, which would
 * credit 2 cents against a 1.5-cent overhang and release more from suspense than
 * was ever put there. Truncation toward zero is correct because it always posts
 * the part that has genuinely cleared and carries a remainder strictly smaller
 * than a cent, whichever side of zero the residual is on.
 *
 * Two invariants hold for every input, and both are asserted in
 * scripts/verify-rollup.ts:
 *   postable + carried === residual   (exactly — nothing is created or lost)
 *   |carried| < CENT_BASE_UNITS       (nothing postable is left behind)
 */
export function clearable(residual: bigint): ClearedAmount {
  const postable = (residual / CENT_BASE_UNITS) * CENT_BASE_UNITS;
  return { postable, carried: residual - postable };
}

/**
 * A source with money not yet absorbed into any line for its bucket.
 *
 * `sourceId` names a payment for a spend class and a receipt for an earn class,
 * which is what `sourceKindFor` decides. It was `paymentId`, and renaming it
 * was the point rather than a tidy-up: a field called `paymentId` holding a
 * receipt id is a lie that typechecks, and the rename makes the compiler walk
 * every call site so nobody has to remember which one they are looking at. Same
 * reasoning 0012 gave for changing `directionFor`'s signature.
 */
export interface AbsorptionCandidate {
  sourceId: string;
  /**
   * How much of this source the bucket still owes (positive) or has
   * over-posted (negative). Not the source's full amount: it may be partly
   * absorbed by an earlier line.
   */
  available: bigint;
  /** The day the ledger dates this source by. Decides the line's posting day. */
  ledgerDay: string;
}

export interface Absorption {
  sourceId: string;
  absorbed: bigint;
  ledgerDay: string;
}

/**
 * Chooses which payments a line absorbs, and how much of each.
 *
 * Oldest first, matching the order listPaymentsForExport reads in — a ledger
 * reads forwards in time, and the oldest unposted spend should clear first.
 * Callers pass candidates already sorted.
 *
 * ABSORPTION IS PARTIAL, and it has to be. A line posts an exact whole number of
 * cents, but payments are arbitrary amounts, so the last payment a line reaches
 * is usually absorbed in part — 500 base units of a 1,000-unit payment, with the
 * other 500 left for the next run. Absorbing only whole payments was considered
 * and rejected: with $0.0015 payments no run of them sums to a whole cent until
 * the twentieth, so whether a bucket ever cleared would depend on an arithmetic
 * coincidence rather than on how much was spent.
 *
 * Works in both directions. Given a negative `postable` (a reclass credit) the
 * candidates carry negative `available` and this walks them the same way,
 * unwinding oldest first. The comparisons are written against magnitudes so the
 * two directions share one code path rather than a mirrored copy that could
 * drift.
 *
 * Guarantees, for a `postable` that is a multiple of CENT_BASE_UNITS and
 * candidates whose `available` values sum to at least |postable| in the same
 * direction: the returned absorptions sum to exactly `postable`, and no single
 * absorption exceeds that candidate's `available`.
 */
export function planAbsorption(
  postable: bigint,
  candidates: AbsorptionCandidate[],
): Absorption[] {
  if (postable === 0n) return [];

  const absorptions: Absorption[] = [];
  // Tracked as a magnitude so one loop serves both directions. `sign` puts the
  // direction back on at the end.
  const sign = postable < 0n ? -1n : 1n;
  let remaining = postable * sign;

  for (const candidate of candidates) {
    if (remaining === 0n) break;

    // A candidate pointing the other way cannot help settle this line, and
    // absorbing it would post money in the wrong direction. Skip rather than
    // throw: a bucket can legitimately hold both while a status change is
    // half-reflected, and the next run picks it up.
    const available = candidate.available * sign;
    if (available <= 0n) continue;

    const take = available < remaining ? available : remaining;
    absorptions.push({
      sourceId: candidate.sourceId,
      absorbed: take * sign,
      ledgerDay: candidate.ledgerDay,
    });
    remaining -= take;
  }

  // Unreachable when the caller derived `postable` from these same candidates,
  // which is the only way it is called. Loud rather than silent because the
  // alternative is a line whose parts do not sum to its total — money invented
  // or lost, which is precisely what this slice must never do.
  if (remaining !== 0n) {
    throw new Error(
      `planAbsorption could not cover ${postable} base units: ${remaining * sign} left unabsorbed`,
    );
  }

  return absorptions;
}

/**
 * The day a line carries: the ledger day of the NEWEST payment it absorbed.
 *
 * Derived from the data rather than from the clock, so re-running the engine
 * later produces identical dates — a line is reproducible from the payments that
 * fed it. Dating by the newest constituent also means a line never claims spend
 * was booked before it was incurred, which dating by the oldest would.
 *
 * Compared as strings: every value is a fixed-width `YYYY-MM-DD` slice of a UTC
 * toISOString(), so lexicographic order is chronological order. The same
 * property velocity.ts and listPaymentsForExport already rely on.
 */
export function postingDayFor(absorptions: Absorption[]): string {
  if (absorptions.length === 0) {
    throw new Error("postingDayFor requires at least one absorption");
  }
  return absorptions.reduce(
    (newest, a) => (a.ledgerDay > newest ? a.ledgerDay : newest),
    absorptions[0]!.ledgerDay,
  );
}
