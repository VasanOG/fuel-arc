/**
 * The one place a payment status becomes words a person reads.
 *
 * Before this existed the vocabulary lived in two places: `ledgerStatus` in
 * ./export-presentation.ts, which an accountant reads in a CSV, and a
 * hand-copied duplicate in dashboard/lib/presentation.ts, which an operator
 * read on a screen. Two copies of a vocabulary drift, and the drift is silent —
 * nothing fails, the two surfaces just stop agreeing about what happened to a
 * payment. The backend owns it now and both surfaces read it.
 *
 * WHY TONE LIVES HERE, in the backend, rather than being a styling decision.
 * "Which of these outcomes is alarming" is a domain judgement, not a palette
 * one: `blocked` means Fuel refused to spend, `unreconciled` means Fuel does
 * not know whether money moved. A dashboard that guessed severity from a status
 * string it did not understand would eventually guess wrong, and the wrong
 * direction to guess is "this looks fine".
 *
 * Every function here is pure and total. Nothing throws: a surface that dies on
 * one malformed row is worse than one that degrades on that row.
 */

import type { ApprovableScope, ApprovalStatus } from "../db/approvals.js";
import type { PaymentStatus } from "../db/payments.js";
import type { ReceiptStatus } from "../db/receipts.js";

/**
 * Semantic weight, not a colour.
 *
 * `bad` is reserved for refused and failed. A surface may render these however
 * it likes, but it may not invent a fifth.
 */
export type Tone = "good" | "watch" | "bad" | "quiet";

export interface StatusPresentation {
  /** The phrase shown to a person. Also what the CSV prints. */
  label: string;
  tone: Tone;
  /** One sentence a surface can show on demand. Never mentions internals. */
  meaning: string;
}

/**
 * Exhaustive over PaymentStatus by construction: adding a status to the union
 * without deciding how it reads is a compile error, which is the point.
 *
 * These label strings are a CONTRACT, not a preference. They are printed into
 * accounting exports that leave the system permanently, so changing one changes
 * a customer's records. scripts/verify-api.ts pins all six.
 */
export const PAYMENT_PRESENTATION: Record<PaymentStatus, StatusPresentation> = {
  settled: {
    label: "Paid",
    tone: "good",
    meaning: "The payment completed and the money moved.",
  },
  unreconciled: {
    label: "Awaiting confirmation",
    tone: "watch",
    meaning:
      "The payment was authorised but never confirmed. Fuel holds the budget as spent because it cannot rule out that the money moved.",
  },
  blocked: {
    label: "Refused",
    tone: "bad",
    meaning: "Fuel refused the payment before anything was authorised. No money moved.",
  },
  failed: {
    label: "Not completed",
    tone: "bad",
    meaning: "The payment did not complete, and nothing was authorised. No money moved.",
  },
  pending: {
    label: "In progress",
    tone: "quiet",
    meaning: "Budget is reserved and the payment has not resolved yet.",
  },
  signing: {
    label: "In progress",
    tone: "quiet",
    meaning: "Budget is reserved and the payment has not resolved yet.",
  },
};

/**
 * The fallback is unreachable while the record above is exhaustive, but a row
 * read from a database a future migration has moved ahead of this code should
 * degrade rather than crash an export.
 */
const UNKNOWN: StatusPresentation = {
  label: "Unknown",
  tone: "quiet",
  meaning: "Fuel does not recognise this payment's state.",
};

export function presentStatus(status: PaymentStatus): StatusPresentation {
  return PAYMENT_PRESENTATION[status] ?? UNKNOWN;
}

/**
 * The inbound half. Exhaustive over ReceiptStatus by the same construction.
 *
 * IT EXISTS BECAUSE THE FALLBACK ABOVE WOULD HAVE SWALLOWED THE DIFFERENCE.
 * `presentStatus` takes a PaymentStatus and returns UNKNOWN for anything else,
 * so passing a receipt status through it compiles the moment a union widens and
 * writes the literal word "Unknown" into an accounting export. That is the same
 * failure 0012 diagnosed in ledgerAccount's `?? "Unknown"` — a widening that
 * produces silence rather than a complaint — sitting in the sibling function
 * nobody looked at.
 *
 * Only `settled` can reach a posted line today, since nothing else is ever
 * absorbed. The other four are here anyway: a Record over the full union is
 * what makes adding a status a compile error instead of a quiet "Unknown".
 *
 * The labels say what happened to the MONEY, not what Fuel did about it,
 * because that is the question an accounting export answers.
 */
export const RECEIPT_PRESENTATION: Record<ReceiptStatus, StatusPresentation> = {
  settled: {
    label: "Received",
    tone: "good",
    meaning: "Settlement confirmed. The money arrived.",
  },
  settle_unknown: {
    label: "Awaiting confirmation",
    tone: "watch",
    meaning:
      "The request was served and settlement could not be confirmed either way. Not booked as revenue, because unconfirmed income overstates what was earned.",
  },
  served_unsettled: {
    label: "Served, not paid",
    tone: "bad",
    meaning: "The origin did the work and settlement failed. No money arrived.",
  },
  abandoned: {
    label: "Not completed",
    tone: "bad",
    meaning: "The request never reached the origin, and no settlement was attempted.",
  },
  awaiting: {
    label: "In progress",
    tone: "quiet",
    meaning: "Fuel is still handling this request and it has not resolved yet.",
  },
};

export function presentReceiptStatus(status: ReceiptStatus): StatusPresentation {
  return RECEIPT_PRESENTATION[status] ?? UNKNOWN;
}

/**
 * Why Fuel refused a payment, as a closed set.
 *
 * One code per refusal site in `reserveIfUnderCap`. These are the only values
 * `payments.refusal_code` may hold; there is no free-text variant and no
 * "other". A new reason means a new member here and a compile error at the
 * write site, which is how it stays closed.
 *
 * Scoped to `blocked` rows deliberately. `failed` and `unreconciled` carry
 * upstream transport errors, which are a different kind of thing from a policy
 * refusal, and giving them codes from this set would assert a structure the
 * data does not have.
 */
export const REFUSAL_CODES = [
  "AGENT_FROZEN",
  "APPROVAL_INVALID",
  "AGENT_CAP",
  "TEAM_CAP",
  "COMPANY_CAP",
  "VELOCITY",
  "ANOMALY",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === "string" && (REFUSAL_CODES as readonly string[]).includes(value);
}

/**
 * The refusal, in words.
 *
 * Deliberately says what rule was hit and nothing about the numbers behind it.
 * The prose in `payments.detail` carries thresholds and medians in BASE UNITS —
 * the storage representation — and re-presenting those would leak both an
 * internal unit and an agent's behavioural baseline.
 */
const REFUSAL_PRESENTATION: Record<RefusalCode, string> = {
  AGENT_FROZEN: "The agent was frozen",
  APPROVAL_INVALID: "The approval could not be redeemed",
  AGENT_CAP: "Over the agent's own cap",
  TEAM_CAP: "Over the team's cap",
  COMPANY_CAP: "Over the company's cap",
  VELOCITY: "Too many payments too quickly",
  ANOMALY: "An unusual amount, held for review",
};

/**
 * Null for every payment recorded before refusal codes existed.
 *
 * Those rows have prose in `detail` that looks parseable — "would exceed team
 * spend cap" — and it is deliberately not parsed. Free text was never a
 * contract, and deriving a code from it would be inventing a record rather than
 * reading one. A surface should say the reason is unavailable.
 */
export function presentRefusal(
  code: string | null,
): { code: RefusalCode; label: string } | null {
  if (!isRefusalCode(code)) return null;
  return { code, label: REFUSAL_PRESENTATION[code] };
}

/* -------------------------------------------------------------------------
 * Approvals.
 *
 * Same job, one level up: a payment status says what happened to money, an
 * approval status says what happened to a REQUEST to move it. They live in one
 * file because they are read together — an operator looking at a held payment
 * is reading both — and because the alternative is a second vocabulary owner,
 * which is the drift this file exists to stop.
 * ---------------------------------------------------------------------- */

/**
 * Exhaustive over ApprovalStatus by construction, for the same reason
 * PAYMENT_PRESENTATION is: a new status that nobody decided how to read is a
 * compile error rather than a blank cell.
 *
 * `consumed` is the one worth reading twice. It does not mean "approved and
 * finished" — it means an agent redeemed the one-time exemption and a payment
 * went through above a ceiling. Labelling it "Approved" would hide the only
 * state in which an approval actually cost money.
 */
export const APPROVAL_PRESENTATION: Record<ApprovalStatus, StatusPresentation> = {
  pending: {
    label: "Waiting for a decision",
    tone: "watch",
    meaning: "A payment is held until someone approves or denies it.",
  },
  approved: {
    label: "Approved",
    tone: "good",
    meaning:
      "Approved once, for this payment only. It expires if the agent does not retry in time, and no spending limit was changed.",
  },
  denied: {
    label: "Denied",
    tone: "bad",
    meaning: "Refused by a person. The payment did not happen.",
  },
  consumed: {
    label: "Used",
    tone: "quiet",
    meaning: "The agent retried and the approved payment went through.",
  },
  expired: {
    label: "Expired",
    tone: "quiet",
    meaning: "Nobody decided in time, or it was approved and never used. The payment did not happen.",
  },
};

const UNKNOWN_APPROVAL: StatusPresentation = {
  label: "Unknown",
  tone: "quiet",
  meaning: "Fuel does not recognise this request's state.",
};

export function presentApprovalStatus(status: ApprovalStatus): StatusPresentation {
  return APPROVAL_PRESENTATION[status] ?? UNKNOWN_APPROVAL;
}

/**
 * What approving this would actually permit.
 *
 * Kept distinct in words, not just in the enum, because the two are not the
 * same permission. A team or company approval waives a spending ceiling for one
 * payment; an anomaly approval waives nothing about budgets at all — every cap
 * still applies, and the only question is whether the payment was intended.
 * See src/db/approvals.ts, where collapsing the two is called out as the
 * mistake that would hand out a budget bypass nobody granted.
 */
const SCOPE_PRESENTATION: Record<ApprovableScope, string> = {
  team: "Over the team's limit",
  company: "Over the company's limit",
  anomaly: "Unusual for this agent",
};

export function presentScope(scope: ApprovableScope): string {
  return SCOPE_PRESENTATION[scope] ?? "Held for review";
}

/**
 * The status filters the Activity Ledger may offer, across both directions.
 *
 * THE TWO VOCABULARIES ARE NOT DISJOINT, which is the whole problem this
 * solves and the thing an earlier draft of this file got wrong. `PaymentStatus`
 * and `ReceiptStatus` share exactly one word — `settled` — and it means the
 * same event on both sides: the money moved. Everything else belongs to one
 * direction only. On top of that, three LABELS collide across different words:
 * "Not completed" is `failed` outbound and `abandoned` inbound, "In progress"
 * is `pending`/`signing` outbound and `awaiting` inbound, and "Awaiting
 * confirmation" is `unreconciled` outbound and `settle_unknown` inbound.
 *
 * Two separate menus would therefore offer an operator two different options
 * that issue the identical query (`status=settled`, labelled "Paid" in one list
 * and "Received" in the other) and several more that look unrelated but ask the
 * same question of opposite directions. So the menu is MERGED rather than
 * grouped, in two passes:
 *
 *   1. A word that carries two labels becomes one option naming both —
 *      `settled` reads "Paid or received", because a filter that matches both
 *      directions should say so rather than pick a side.
 *   2. Options that end up sharing a label are collapsed, joining their words.
 *      That is the same by-label deduplication this file has always done for
 *      `pending` and `signing`, now applied across the directions too.
 *
 * The result is one option per question a person would actually ask, each
 * matching every row that answers it in either direction. `value` is what goes
 * back on the query string; GET /api/activity accepts a comma-separated list,
 * so a collapsed group round-trips as one option.
 */
export function ledgerStatusFilters(): { value: string; label: string }[] {
  const labelsByStatus = new Map<string, string[]>();
  const record = (status: string, label: string) => {
    const existing = labelsByStatus.get(status) ?? [];
    if (!existing.includes(label)) labelsByStatus.set(status, [...existing, label]);
  };
  // Outbound first, so the merged labels read "Paid or received" rather than
  // the reverse. Spend is the older and larger half of the ledger, and a stable
  // order keeps a filter menu from reshuffling between releases.
  for (const [status, { label }] of Object.entries(PAYMENT_PRESENTATION)) record(status, label);
  for (const [status, { label }] of Object.entries(RECEIPT_PRESENTATION)) record(status, label);

  const byLabel = new Map<string, string[]>();
  for (const [status, labels] of labelsByStatus) {
    const label = joinLabels(labels);
    byLabel.set(label, [...(byLabel.get(label) ?? []), status]);
  }
  return [...byLabel].map(([label, statuses]) => ({ value: statuses.join(","), label }));
}

/**
 * "Paid" + "Received" -> "Paid or received".
 *
 * Only the first keeps its capital, because the result is one phrase rather
 * than a list of proper nouns. A single label passes through untouched, which
 * is every status but one.
 */
function joinLabels(labels: string[]): string {
  if (labels.length === 1) return labels[0]!;
  const [first, ...rest] = labels;
  return [first, ...rest.map((l) => l.charAt(0).toLowerCase() + l.slice(1))].join(" or ");
}

/* -------------------------------------------------------------------------
 * The two ways Fuel counts money, in words.
 * ---------------------------------------------------------------------- */

/**
 * Why a cap figure and a P&L figure disagree, said once.
 *
 * THE TWO NUMBERS ARE NOT COMPARABLE AND WILL NOT AGREE, by design. A cap sums
 * `COUNTS_AGAINST_CAP` — `pending`, `signing`, `settled` and `unreconciled` —
 * because a ceiling has to count money that MIGHT move, and a signed
 * authorization stays spendable until it expires. A P&L sums `APPEARS_IN_LEDGER`
 * — `settled` and `unreconciled` — because it reports money that DID move.
 *
 * Put a "spent" from each beside the other with no label and an operator reads
 * a discrepancy where there is a definition. So the label travels with the
 * figures rather than being written into a template, for the reason 5B-2 gave
 * when it deleted the dashboard's copy of the status table: two copies of a
 * vocabulary drift silently, and this one explains an arithmetic that surprises
 * people.
 *
 * It says nothing about receipts because the earn side has only one basis —
 * `APPEARS_IN_RECEIPT_LEDGER` is `('settled')` alone, so there is no second
 * earned figure to be confused with.
 */
export const LEDGER_BASIS_NOTE =
  "These count money that moved: settled payments, plus authorised ones Fuel " +
  "could not confirm, because it cannot rule out that they moved. Earnings " +
  "count only confirmed receipts — unconfirmed income would overstate what was " +
  "earned. The spend cap beside them counts money that might still move, so a " +
  "payment in flight is in that figure and not in these. The two answer " +
  "different questions and will not agree.";
