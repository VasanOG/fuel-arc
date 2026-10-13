/**
 * What Fuel can tell a person about, as a closed vocabulary (ADR 0021).
 *
 * ONE LIST, READ BY THE OVERVIEW AND BY THE SWEEPER. The Overview's "needs
 * attention" list used to be computed inside dashboard/app/page.tsx, from three
 * API calls and the dashboard's own arithmetic. An alert built from a second
 * copy of those rules would disagree with the screen the first time either was
 * edited. So both now read `attentionFor` (./attention.ts), and this file names
 * every kind of item that function can produce.
 *
 * WHAT IS DELIBERATELY ABSENT, so nobody reads its absence as an oversight:
 *   - QuickBooks FAILING. A refresh failure throws in src/quickbooks/client.ts
 *     and is never stored, so there is nothing to read. Detecting it means a
 *     write in money-adjacent code: its own slice.
 *   - A misconfigured sign-in relay (`relay_rejected`, ADR 0020). It is an
 *     in-memory refusal that fires before sign-in identifies any company, so no
 *     company's webhook can own it. It is a platform signal, for platform
 *     monitoring.
 * verify-api asserts both stay out of this list (AL-A6).
 */

/** How serious a condition is. Which hourly ceiling it spends is `ceilingOf`, below. */
export type Severity = "money" | "watch";

export const ALERT_EVENTS = [
  // money: a person has to act, or money may be wrong
  "approval_waiting",
  "anomaly_hold",
  "payment_unreconciled",
  "receipt_stuck",
  "posting_needs_reconciling",
  "frozen_still_paying",
  "quickbooks_expired",
  // watch: worth knowing, nothing is wrong yet
  "quickbooks_expiring",
  "agent_throttled",
  "agent_near_cap",
  "agent_no_authority",
  "agent_over_authority",
  "team_at_ceiling",
  "agent_frozen",
] as const;

export type AlertEvent = (typeof ALERT_EVENTS)[number];

export const SEVERITY: Record<AlertEvent, Severity> = {
  approval_waiting: "money",
  anomaly_hold: "money",
  payment_unreconciled: "money",
  receipt_stuck: "money",
  posting_needs_reconciling: "money",
  frozen_still_paying: "money",
  quickbooks_expired: "money",
  quickbooks_expiring: "watch",
  agent_throttled: "watch",
  agent_near_cap: "watch",
  agent_no_authority: "watch",
  agent_over_authority: "watch",
  team_at_ceiling: "watch",
  agent_frozen: "watch",
};

/**
 * Which hourly message ceiling an event spends (security review of commit 1,
 * F-1).
 *
 * THREE, NOT TWO. Approvals and anomaly holds are money-severity, but anyone
 * holding the agent key can mint them (varying a URL makes each a new pending
 * request). Sharing a ceiling with unreconciled payments, stuck receipts,
 * postings and QuickBooks expiry would let a flood of approvals use up the
 * hour and hold a real money problem back. So each kind of noise has its own
 * quota, and none can spend another's.
 */
export type Ceiling = "money" | "approval" | "watch";

export function ceilingOf(event: AlertEvent): Ceiling {
  if (event === "approval_waiting" || event === "anomaly_hold") return "approval";
  return SEVERITY[event] === "money" ? "money" : "watch";
}

/** Messages per company per rolling hour, by ceiling. */
export const MESSAGES_PER_HOUR: Record<Ceiling, number> = { money: 10, approval: 6, watch: 4 };

/**
 * The words a person reads, chosen here and nowhere else. A closed lookup, so
 * nothing a caller or an operator typed can become a label, and no crypto term
 * can reach a webhook through one (CLAUDE.md). Plural forms are for a collapsed
 * line ("3 payments held for approval").
 */
export const LABEL: Record<AlertEvent, { one: string; many: string }> = {
  approval_waiting: { one: "Awaiting approval", many: "approvals waiting" },
  anomaly_hold: { one: "Held as unusual", many: "payments held as unusual" },
  payment_unreconciled: { one: "Payment outcome unknown", many: "payments with an unknown outcome" },
  receipt_stuck: { one: "Incoming payment unresolved", many: "incoming payments unresolved" },
  posting_needs_reconciling: {
    one: "Accounting entry needs reconciling",
    many: "accounting entries need reconciling",
  },
  frozen_still_paying: { one: "Frozen agent still trying to pay", many: "frozen agents still trying to pay" },
  quickbooks_expired: { one: "QuickBooks connection expired", many: "QuickBooks connection expired" },
  quickbooks_expiring: { one: "QuickBooks connection expiring soon", many: "QuickBooks connection expiring soon" },
  agent_throttled: { one: "Rate-limited", many: "agents rate-limited" },
  agent_near_cap: { one: "Near its cap", many: "agents near their cap" },
  agent_no_authority: { one: "No authority left", many: "agents with no authority left" },
  agent_over_authority: { one: "Over authority", many: "agents over authority" },
  team_at_ceiling: { one: "Team at its ceiling", many: "teams at their ceiling" },
  agent_frozen: { one: "Frozen", many: "agents frozen" },
};

/** Near-cap fires at this share of the cap, in percent. Proposed and approved: 80. */
export const NEAR_CAP_PERCENT = 80n;

/** How recent a rate-limit refusal must be for an agent to count as throttled. */
export const THROTTLE_WINDOW_MS = 10 * 60 * 1000;

/**
 * A posting is `pending` for a few seconds during every ordinary post
 * (`beginPosting` → `markPosted`). Older than this, it is waiting on a person.
 */
export const POSTING_GRACE_MS = 2 * 60 * 1000;

/** QuickBooks refresh grants this close to expiry are worth a warning. */
export const QUICKBOOKS_EXPIRING_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A condition that clears and comes back within this long reopens its old row
 * SILENTLY. Without it, an agent bouncing off its rate limit, or a freeze
 * toggled on and off, would page the owner every time.
 */
export const COOLDOWN_MS = 60 * 60 * 1000;
