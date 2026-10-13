import { randomUUID } from "node:crypto";
import { assessAmount, BASELINE_WINDOW, type AnomalyVerdict } from "../payments/anomaly.js";
import { recordFrozenAttempt } from "./agents.js";
import {
  assessVelocity,
  retryAfterSeconds,
  VELOCITY_WINDOW_MS,
  type VelocityVerdict,
} from "../payments/velocity.js";
import { db } from "./index.js";
import { isRefusalCode, type RefusalCode } from "../lib/payment-presentation.js";

export type PaymentStatus =
  | "pending"
  | "signing"
  | "settled"
  | "blocked"
  | "failed"
  | "unreconciled";

/**
 * The same six as a value, because a type union does not survive to runtime.
 *
 * Mirrors `RECEIPT_STATUSES` in receipts.ts, and exists for the same two
 * callers: a route that has to validate a caller's status filter, and
 * db/ledger.ts, which has to decide which direction a filter word constrains —
 * a question with two answers for `settled`, the one word both vocabularies
 * hold. Both were previously served by a private copy in src/api.ts
 * — a third list of these six, alongside this type and the CHECK constraint in
 * ./index.ts, and the only one no compiler or database would have complained
 * about drifting.
 */
export const PAYMENT_STATUSES: PaymentStatus[] = [
  "pending",
  "signing",
  "settled",
  "blocked",
  "failed",
  "unreconciled",
];

/**
 * The statuses under which money might move, or might already have moved.
 * These are what a cap has to count.
 */
const COUNTS_AGAINST_CAP = "('pending', 'signing', 'settled', 'unreconciled')";

/**
 * The statuses that belong in an accounting ledger.
 *
 * Deliberately NOT the same set as COUNTS_AGAINST_CAP, and the difference is
 * not an oversight. A cap counts money that MIGHT still move, so it has to
 * include in-flight reservations — being wrong in the cautious direction there
 * costs a rejected payment. A ledger reports money that DID move, so in-flight
 * rows have no place in it: they are transient (the reaper resolves them within
 * two minutes) and booking one would record a transaction that may never
 * happen.
 *
 * `unreconciled` is in both sets for the same underlying reason — it was
 * signed, so we must assume the money moved — but the export labels it
 * distinctly rather than calling it paid, because the system genuinely does
 * not know.
 *
 * `blocked` and `failed` are excluded: nothing was ever signed, so no money
 * moved. They are governance events, retrievable via the export's audit mode.
 *
 * Exported so the accounting rollup filters on the SAME set rather than a
 * second copy of it. Two definitions of "belongs in the books" that could drift
 * apart is how a ledger and its rollup stop agreeing — and the rollup's
 * expense/suspense split is precisely a partition of this set, so a divergence
 * would leave payments owed to no bucket at all.
 */
export const APPEARS_IN_LEDGER = "('settled', 'unreconciled')";

export interface Payment {
  id: string;
  agentId: string;
  amountBaseUnits: bigint;
  resourceUrl: string;
  status: PaymentStatus;
  txHash: string | null;
  detail: string | null;
  createdAt: string;
  /** When money moved. NULL unless settled, and NULL for rows that settled
   *  before the column existed — see the schema comment in ./index.ts. */
  settledAt: string | null;
  /** Why Fuel refused, on 'blocked' rows recorded after 5B-2. NULL on every
   *  earlier row, and never derived from `detail`. */
  refusalCode: RefusalCode | null;
  /** Seeded by scripts/seed-demo-day.ts. No production path can set it. */
  isDemo: boolean;
}

/**
 * Exported for db/ledger.ts alone, which selects `p.*` for the spend half of a
 * merged page and must map it the same way every other read does. A second copy
 * of this mapping is the drift this avoids; a wider public surface is the cost.
 */
export interface PaymentRow {
  id: string;
  agent_id: string;
  amount_base_units: number | bigint;
  resource_url: string;
  status: PaymentStatus;
  tx_hash: string | null;
  detail: string | null;
  created_at: string;
  settled_at: string | null;
  refusal_code: string | null;
  is_demo: number | bigint;
}

export function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    agentId: row.agent_id,
    amountBaseUnits: BigInt(row.amount_base_units),
    resourceUrl: row.resource_url,
    status: row.status,
    txHash: row.tx_hash,
    detail: row.detail,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    // Anything unrecognised reads as "no reason recorded" rather than being
    // passed through: a code this build does not know is not a code it can
    // present, and inventing a label for it would be worse than saying nothing.
    refusalCode: isRefusalCode(row.refusal_code) ? row.refusal_code : null,
    isDemo: Number(row.is_demo) === 1,
  };
}

/**
 * Spend that counts against the cap.
 *
 * Derived from the payments table rather than kept as a running total on the
 * agent, so it cannot drift out of sync with what actually happened.
 *
 * Counts `pending` (budget is committed the moment we decide to pay, not when
 * settlement returns), `signing`, `settled`, and `unreconciled`.
 *
 * `unreconciled` counts because those payments were SIGNED before failing, and
 * a signed EIP-3009 authorization stays spendable by the facilitator until it
 * expires. Treating them as free budget would let a resource server settle,
 * return an error, and be paid again — without limit. `signing` counts for the
 * same reason: the authorization may already exist.
 *
 * `blocked` and `failed` do not count: nothing was signed, so no money can move.
 */
export function spentBaseUnits(agentId: string): bigint {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_base_units), 0) AS total
       FROM payments
       WHERE agent_id = ? AND status IN ${COUNTS_AGAINST_CAP}`,
    )
    .get(agentId) as { total: number | bigint };
  return BigInt(row.total);
}

/** The same total, summed across every agent on a team. */
export function teamSpentBaseUnits(teamId: string): bigint {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount_base_units), 0) AS total
       FROM payments p
       JOIN agents a ON a.id = p.agent_id
       WHERE a.team_id = ? AND p.status IN ${COUNTS_AGAINST_CAP}`,
    )
    .get(teamId) as { total: number | bigint };
  return BigInt(row.total);
}

/** And across every agent on every team in a company. */
export function companySpentBaseUnits(companyId: string): bigint {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount_base_units), 0) AS total
       FROM payments p
       JOIN agents a ON a.id = p.agent_id
       JOIN teams t ON t.id = a.team_id
       WHERE t.company_id = ? AND p.status IN ${COUNTS_AGAINST_CAP}`,
    )
    .get(companyId) as { total: number | bigint };
  return BigInt(row.total);
}

/* -------------------------------------------------------------------------
 * The LEDGER basis, as distinct from the cap basis above.
 *
 * THE THREE FUNCTIONS ABOVE ANSWER A DIFFERENT QUESTION FROM THE TWO BELOW,
 * and 6B-3 puts both families on one screen, so the difference has to be
 * structural rather than remembered.
 *
 *   spentBaseUnits / teamSpentBaseUnits / companySpentBaseUnits
 *       sum COUNTS_AGAINST_CAP. A cap must count money that MIGHT move, so
 *       `pending` and `signing` are included. Being wrong in the cautious
 *       direction costs a rejected payment.
 *
 *   ledgerSpentBaseUnits / companyLedgerSpentBaseUnits
 *       sum APPEARS_IN_LEDGER. A P&L reports money that DID move, so in-flight
 *       rows have no place in it — reporting profit that includes reservations
 *       which may never settle would be reporting a result that has not
 *       happened.
 *
 * They are usually close and they are not the same, and a page showing both
 * unlabelled would present two numbers that look comparable and are not. That
 * is why every figure built on these names its basis; see presentLedgerTotals
 * in src/api.ts.
 * ---------------------------------------------------------------------- */

/** What this agent's payments actually moved. Never a cap figure. */
export function ledgerSpentBaseUnits(agentId: string): bigint {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM payments
       WHERE agent_id = ? AND status IN ${APPEARS_IN_LEDGER}`,
    )
    .get(agentId) as { total: number | bigint };
  return BigInt(row.total);
}

/** The same, for a whole company, through the usual agents -> teams seam. */
export function companyLedgerSpentBaseUnits(companyId: string): bigint {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount_base_units), 0) AS total
       FROM payments p
       JOIN agents a ON a.id = p.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE t.company_id = ? AND p.status IN ${APPEARS_IN_LEDGER}`,
    )
    .get(companyId) as { total: number | bigint };
  return BigInt(row.total);
}

/**
 * The agent's recent payment amounts, newest first — the sample the anomaly
 * baseline is computed from.
 *
 * Reuses COUNTS_AGAINST_CAP so "spend that happened" means one thing across the
 * whole codebase. That choice has teeth here: `research-bot` has 56 payment
 * rows of which 42 are `blocked`, and letting refused payments shape the
 * baseline would mean an agent could move its own baseline by attempting
 * payments it was never allowed to make.
 */
export function recentAmountsForBaseline(agentId: string, limit: number): bigint[] {
  const rows = db
    .prepare(
      `SELECT amount_base_units AS amount
       FROM payments
       WHERE agent_id = ? AND status IN ${COUNTS_AGAINST_CAP}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(agentId, limit) as unknown as { amount: number | bigint }[];
  return rows.map((r) => BigInt(r.amount));
}

/**
 * Spend inside the recent rate-limit window, plus the timestamp of the oldest
 * payment in it (for the retry hint). One pass, so both figures come from the
 * same snapshot.
 *
 * Reuses COUNTS_AGAINST_CAP, and here that is not merely consistency — it is
 * what stops the limit from sustaining itself. A refusal writes a `blocked`
 * payment row; if `blocked` counted toward the window, every refusal would push
 * the window forward and an agent that hit the limit once could never get out
 * of it. Excluding them means the window genuinely drains.
 */
export function spendInWindow(
  agentId: string,
  windowMs: number,
): { total: bigint; oldest: string | null } {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_base_units), 0) AS total, MIN(created_at) AS oldest
       FROM payments
       WHERE agent_id = ? AND status IN ${COUNTS_AGAINST_CAP} AND created_at > ?`,
    )
    .get(agentId, cutoff) as { total: number | bigint; oldest: string | null };
  return { total: BigInt(row.total), oldest: row.oldest };
}

/** Which of the three ceilings refused the payment. */
export type CapScope = "agent" | "team" | "company";

export type ReserveResult =
  | { ok: true; paymentId: string }
  // An operator stopped this agent. Outranks every other refusal: there is no
  // cap to raise, nothing to queue, and waiting will not help.
  | { ok: false; refusal: "frozen"; frozenAt: string; frozenReason: string | null }
  | { ok: false; refusal: "cap"; scope: CapScope; spent: bigint; cap: bigint }
  // A redemption that never got as far as a cap check: the approval was not
  // valid for this payment. Distinct because the fix is different — there is
  // no cap to raise, the agent needs a new approval.
  | { ok: false; refusal: "approval"; reason: string }
  // Passed every cap, but the amount is out of character for this agent.
  // Distinct from a cap refusal because there is no budget problem to fix: the
  // question for the human is "did you mean this?", not "raise a limit".
  | { ok: false; refusal: "anomaly"; verdict: AnomalyVerdict }
  // Spending too fast. The only refusal that resolves itself: no human, no cap
  // to raise, just wait for the window to slide.
  | { ok: false; refusal: "velocity"; verdict: VelocityVerdict; retryAfterSeconds: number };

/**
 * Atomically check all three caps — the agent's, its team's, and its
 * company's — and reserve budget for a payment.
 *
 * This must happen BEFORE anything is signed. An EIP-3009 authorization is
 * spendable the instant it exists, so a cap checked afterwards is not a cap.
 *
 * The reads and the insert share one IMMEDIATE transaction. Without that, two
 * concurrent requests can both read "under cap" and both go on to pay —
 * a time-of-check-to-time-of-use overspend. IMMEDIATE takes a database-level
 * write lock, so the team and company checks get the same protection as the
 * per-agent one for free: concurrent reserves for *different* agents, even on
 * different teams, serialise too.
 *
 * Redeeming an approval happens in this same transaction, for the same reason
 * and not as a convenience: the approval is validated, the team and company
 * ceilings are skipped, and the approval is burned, all under that one lock.
 * Validating an approval outside it would let two concurrent retries carrying
 * one approval id both find it valid and both pay — the exemption is meant to
 * be spendable exactly once.
 */
export function reserveIfUnderCap(params: {
  agentId: string;
  amountBaseUnits: bigint;
  resourceUrl: string;
  /**
   * An approved request being redeemed. What it exempts depends on WHY it was
   * raised (its `blocked_scope`), not merely on its existing:
   *
   *   team/company → the team and company ceilings are skipped for this one
   *                  payment. That is what a cap approval buys.
   *   anomaly      → nothing is skipped except the anomaly rule. The payment
   *                  passed every cap when it was flagged and must pass them
   *                  again now.
   *
   * Any approval skips the anomaly check: a human has already looked at this
   * exact agent, url and amount and said yes, so re-flagging it would loop
   * forever without asking a new question.
   *
   * The agent's own cap is enforced in every case, and the approval is marked
   * `consumed` in this same transaction.
   */
  approvalRequestId?: string;
}): ReserveResult {
  const { agentId, amountBaseUnits, resourceUrl, approvalRequestId } = params;
  const id = randomUUID();
  const now = new Date().toISOString();

  // IMMEDIATE takes the write lock up front, so a concurrent reserve blocks
  // here rather than reading a stale total and discovering the conflict later.
  db.exec("BEGIN IMMEDIATE");
  try {
    // One join, inside the transaction, so all three caps come from the same
    // atomic snapshot as the spend totals they are compared against.
    const hierarchy = db
      .prepare(
        `SELECT a.spend_cap_base_units AS agent_cap,
                a.frozen_at            AS frozen_at,
                a.frozen_reason        AS frozen_reason,
                t.id                   AS team_id,
                t.spend_cap_base_units AS team_cap,
                c.id                   AS company_id,
                c.spend_cap_base_units AS company_cap
         FROM agents a
         JOIN teams t     ON t.id = a.team_id
         JOIN companies c ON c.id = t.company_id
         WHERE a.id = ?`,
      )
      .get(agentId) as
      | {
          agent_cap: number | bigint;
          frozen_at: string | null;
          frozen_reason: string | null;
          team_id: string;
          team_cap: number | bigint;
          company_id: string;
          company_cap: number | bigint;
        }
      | undefined;

    // Also catches an agent whose team or company row is missing — unreachable
    // through the NOT NULL foreign keys, but the join fails closed if it ever
    // happens rather than paying with an unenforced ceiling above it.
    if (hierarchy === undefined) {
      db.exec("ROLLBACK");
      throw new Error(`No such agent: ${agentId}`);
    }

    // Recorded, not just refused: an agent repeatedly hitting a cap is exactly
    // the signal Phase 3's anomaly detection will want.
    //
    // `code` is FIRST so a call site cannot quietly omit it: adding an optional
    // trailing parameter would compile everywhere and leave refusals silently
    // uncoded. `detail` stays exactly as it was — it is still the operator-
    // readable prose, it is still written on every refusal, and it still never
    // leaves the API.
    //
    // is_demo is deliberately absent from this INSERT. It defaults to 0, and
    // there is no parameter through which a production path could set it.
    const recordBlocked = (code: RefusalCode, detail: string) =>
      db
        .prepare(
          `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at, refusal_code)
           VALUES (?, ?, ?, ?, 'blocked', NULL, ?, ?, ?)`,
        )
        .run(id, agentId, amountBaseUnits, resourceUrl, detail, now, code);

    // Frozen agents stop here, ahead of everything — including the approval
    // validation and all three caps.
    //
    // This deliberately breaks the narrowest-first ordering the caps follow.
    // Frozen is the most severe state and the most explanatory answer: an
    // operator has decided this agent should not spend at all, so telling its
    // caller to raise a cap, or that its approval looks invalid, would send it
    // chasing a problem that is not the problem.
    //
    // Checked from the row read inside this transaction, so a freeze committed
    // while a payment was in flight is seen rather than missed. And because it
    // precedes the redemption path entirely, an agent holding a valid approved
    // request cannot spend it while frozen — without that, freezing would be
    // decorative for exactly the agent most likely to have one.
    if (hierarchy.frozen_at !== null) {
      recordBlocked("AGENT_FROZEN", `agent is frozen (since ${hierarchy.frozen_at})`);
      // Counted here too, so the tally is complete however the refusal was
      // reached. Only one of the two frozen checks can fire per attempt — the
      // early one in pay.ts returns immediately — so this cannot double-count.
      recordFrozenAttempt(agentId);
      db.exec("COMMIT");
      return {
        ok: false,
        refusal: "frozen",
        frozenAt: hierarchy.frozen_at,
        frozenReason: hierarchy.frozen_reason,
      };
    }

    // An approval, if one is being redeemed, is validated BEFORE any cap is
    // read — an invalid approval is not a budget question and should not be
    // reported as one. A refusal here still records a blocked row, because a
    // rejected redemption is exactly the kind of thing an operator will want
    // to find afterwards.
    let approval: { amount_base_units: number | bigint; blocked_scope: string } | undefined;
    if (approvalRequestId !== undefined) {
      const row = db
        .prepare(
          `SELECT agent_id, amount_base_units, resource_url, status, approval_expires_at, blocked_scope
           FROM approval_requests WHERE id = ?`,
        )
        .get(approvalRequestId) as
        | {
            agent_id: string;
            amount_base_units: number | bigint;
            resource_url: string;
            status: string;
            approval_expires_at: string | null;
            blocked_scope: string;
          }
        | undefined;

      const refuseApproval = (reason: string): ReserveResult => {
        recordBlocked("APPROVAL_INVALID", `approval refused: ${reason}`);
        db.exec("COMMIT");
        return { ok: false, refusal: "approval", reason };
      };

      if (!row) return refuseApproval("no such approval request");
      // Belongs to someone else: never let one agent spend another's exemption.
      if (row.agent_id !== agentId) return refuseApproval("approval belongs to a different agent");
      if (row.status !== "approved") return refuseApproval(`approval is ${row.status}, not approved`);
      if (
        row.approval_expires_at === null ||
        new Date(row.approval_expires_at).getTime() <= Date.now()
      ) {
        return refuseApproval("approval has expired");
      }
      if (row.resource_url !== resourceUrl) {
        return refuseApproval("approval was granted for a different resource");
      }
      // A merchant that raised its price between approval and redemption must
      // not be paid the new number. The operator approved an amount, not a
      // blank cheque — same discipline as the post-signature amount assertion
      // in pay.ts.
      if (amountBaseUnits > BigInt(row.amount_base_units)) {
        return refuseApproval("payment costs more than was approved");
      }
      approval = row;
    }

    const agentCap = BigInt(hierarchy.agent_cap);
    const spent = spentBaseUnits(agentId);

    // Enforced even when redeeming: an approval exempts the ceiling that
    // blocked the payment, never the budget the agent's own operator set.
    if (spent + amountBaseUnits > agentCap) {
      recordBlocked("AGENT_CAP", "would exceed agent spend cap");
      db.exec("COMMIT");
      return { ok: false, refusal: "cap", scope: "agent", spent, cap: agentCap };
    }

    // Then the team's ceiling, then the company's. Ordered narrowest first so
    // the refusal a caller sees is the most actionable one: being told the
    // team is out of budget is useless if the agent's own cap is what actually
    // needs raising.
    //
    // Skipped ONLY for a redemption of a cap approval — that is precisely what
    // such an approval buys, and why it is single-use. An anomaly approval
    // deliberately does not skip them: an operator confirming a payment looks
    // intentional has said nothing about the budget, and reading it as a budget
    // exemption would let an unusual-but-affordable payment quietly become an
    // over-ceiling one.
    const exemptsCapCeilings =
      approval !== undefined &&
      (approval.blocked_scope === "team" || approval.blocked_scope === "company");

    if (!exemptsCapCeilings) {
      const teamCap = BigInt(hierarchy.team_cap);
      const teamSpent = teamSpentBaseUnits(hierarchy.team_id);

      if (teamSpent + amountBaseUnits > teamCap) {
        recordBlocked("TEAM_CAP", "would exceed team spend cap");
        db.exec("COMMIT");
        return { ok: false, refusal: "cap", scope: "team", spent: teamSpent, cap: teamCap };
      }

      const companyCap = BigInt(hierarchy.company_cap);
      const companySpent = companySpentBaseUnits(hierarchy.company_id);

      if (companySpent + amountBaseUnits > companyCap) {
        recordBlocked("COMPANY_CAP", "would exceed company spend cap");
        db.exec("COMMIT");
        return {
          ok: false,
          refusal: "cap",
          scope: "company",
          spent: companySpent,
          cap: companyCap,
        };
      }
    }

    // Rate limit, after every cap and BEFORE the anomaly check.
    //
    // Before the anomaly check so a throttled payment never raises an approval
    // request it could not redeem anyway — which keeps the "at most one
    // approval request per payment" property intact.
    //
    // Deliberately NOT skipped for a redemption, unlike the anomaly check. An
    // operator answering a question about an AMOUNT has said nothing about a
    // RATE, so an approval must not double as a licence to burn budget quickly.
    // This is a safety rail like a cap, not a judgement call — and because it
    // refuses without consuming the approval, the agent simply redeems a moment
    // later.
    const window = spendInWindow(agentId, VELOCITY_WINDOW_MS);
    const velocity = assessVelocity({ amountBaseUnits, spentInWindow: window.total });
    if (velocity.exceeded) {
      const retryAfter = retryAfterSeconds(window.oldest, Date.now());
      recordBlocked(
        "VELOCITY",
        `rate limited: ${window.total} + ${amountBaseUnits} base units exceeds ` +
          `${velocity.limit} per ${VELOCITY_WINDOW_MS / 1000}s; retry in ~${retryAfter}s`,
      );
      db.exec("COMMIT");
      return { ok: false, refusal: "velocity", verdict: velocity, retryAfterSeconds: retryAfter };
    }

    // Behaviour check, LAST — after every cap and the rate limit, and only if
    // all of them passed.
    //
    // The ordering is forced, not stylistic. Flagging before the caps would
    // hold a payment for a human that, once approved, still dies on a cap the
    // operator was never shown — a wasted decision. It also gives the whole
    // path a useful property: a payment produces at most ONE approval request,
    // because a team or company block returns before ever reaching here.
    //
    // Skipped for any redemption: a human has already judged this exact
    // agent/url/amount. Without that, an approved anomaly would be re-flagged
    // on redemption and loop forever.
    if (approval === undefined) {
      const verdict = assessAmount({
        amountBaseUnits,
        sample: recentAmountsForBaseline(agentId, BASELINE_WINDOW),
      });
      if (verdict.anomalous) {
        recordBlocked(
          "ANOMALY",
          `flagged as anomalous: ${amountBaseUnits} base units is above the threshold of ` +
            `${verdict.threshold} (median ${verdict.baseline} over ${verdict.sampleSize} recent payments)`,
        );
        db.exec("COMMIT");
        return { ok: false, refusal: "anomaly", verdict };
      }
    }

    db.prepare(
      `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
    ).run(id, agentId, amountBaseUnits, resourceUrl, now);

    // Burn the approval in the SAME transaction that reserves the budget.
    // This is the single-use guarantee: two concurrent retries carrying one
    // approval id both reach here, but the write lock serialises them and the
    // status guard means the second changes nothing — so it pays nothing.
    // Validating above without this would let both through.
    if (approvalRequestId !== undefined) {
      const { changes } = db
        .prepare(
          `UPDATE approval_requests SET status = 'consumed', payment_id = ?
           WHERE id = ? AND status = 'approved'`,
        )
        .run(id, approvalRequestId);
      if (Number(changes) === 0) {
        // Lost the race, or the reaper expired it between the read above and
        // here. Nothing is reserved and nothing is signed — roll the whole
        // thing back rather than pay against an approval we did not win.
        //
        // Unreachable today: node:sqlite is one synchronous connection and
        // nothing in this transaction yields, so the read above and this
        // UPDATE run in a single JS turn. It is written anyway because that
        // safety is a property of the current driver, not of this code — the
        // moment this moves to Postgres or a second process (see
        // docs/decisions/0004-sqlite-for-phase-1.md), the guard above becomes
        // the only thing standing between two retries and two payments.
        //
        // Deliberately records no `blocked` row: the ROLLBACK would discard
        // it. Losing the audit line is the correct trade for not paying.
        db.exec("ROLLBACK");
        return {
          ok: false,
          refusal: "approval",
          reason: "approval was already used or expired",
        };
      }
    }

    db.exec("COMMIT");
    return { ok: true, paymentId: id };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back or committed; the original error is what matters.
    }
    throw error;
  }
}

/**
 * Records that we are about to sign.
 *
 * Called BEFORE the signing call, not after — the whole point is that if the
 * process dies during signing, the database already says so. Without this the
 * only record of "an authorization may exist" is a local variable, which does
 * not survive a crash, and recovery has to guess between releasing budget that
 * may already be spent and stranding budget that never was.
 */
export function markSigningStarted(paymentId: string): void {
  applyTransition(
    "UPDATE payments SET status = 'signing' WHERE id = ? AND status = 'pending'",
    [paymentId],
    // A no-op means we are about to sign against a reservation that is no
    // longer pending — worth surfacing, because the crash-recovery guarantee
    // depends on this row being written.
    `markSigningStarted(${paymentId})`,
  );
}

/**
 * Statuses a payment can still move out of. Once a payment is `settled`,
 * `failed` or `blocked` its budget consequence is decided and must not be
 * rewritten by a straggler.
 *
 * `unreconciled` is deliberately NOT in this list for the release path: the
 * reaper may have already judged an abandoned payment as "assume the money
 * moved", and a late-arriving request must not be able to overturn that into
 * "released". See markFailedBeforeSigning.
 */
const IN_FLIGHT = ["pending", "signing"];

/** Warns rather than throws: a no-op here is a bookkeeping discrepancy, not a reason to 500. */
function applyTransition(sql: string, params: unknown[], context: string): boolean {
  const { changes } = db.prepare(sql).run(...(params as never[]));
  if (Number(changes) === 0) {
    console.warn(`[payments] ${context} changed no rows — the payment was already resolved`);
    return false;
  }
  return true;
}

/**
 * Money moved and we have the tx hash to prove it.
 *
 * Allowed from `unreconciled` as well as in-flight: if the reaper assumed the
 * worst and the request then came back with a settlement, the settlement is
 * the better record. Budget is consumed under either status, so this cannot
 * release anything. That path is also why `settled_at` is written here rather
 * than only on the in-flight transition: a payment the reaper gave up on still
 * deserves a real settlement date once one is known.
 *
 * `settled_at` is stamped now rather than taken from the caller. It records
 * when we LEARNED the payment settled, which is the closest thing to a
 * settlement time we can honestly claim — the on-chain block time is not
 * something this code observes.
 */
export function markSettled(paymentId: string, txHash: string): void {
  applyTransition(
    `UPDATE payments SET status = 'settled', tx_hash = ?, settled_at = ?
     WHERE id = ? AND status IN ('pending', 'signing', 'unreconciled')`,
    [txHash, new Date().toISOString(), paymentId],
    `markSettled(${paymentId})`,
  );
}

/**
 * Releases the reservation. ONLY safe before anything has been signed — if no
 * authorization exists, no money can move, so the budget is genuinely free.
 *
 * After signing, use markUnreconciled instead.
 *
 * The status guard is what makes that distinction hold under a race. Without
 * it, this sequence releases budget for a payment that may be spendable:
 * the reaper gives up on a slow signing call and records `unreconciled`, then
 * the call finally throws and this runs with `signed` still false, overwriting
 * the reaper's verdict with `failed`. Remote signing (FireblocksSigner) can
 * easily outlast the reaper's window, so this is a live path, not a
 * theoretical one.
 */
export function markFailedBeforeSigning(paymentId: string, detail: string): void {
  applyTransition(
    `UPDATE payments SET status = 'failed', detail = ?
     WHERE id = ? AND status IN (${IN_FLIGHT.map((s) => `'${s}'`).join(", ")})`,
    [detail.slice(0, 500), paymentId],
    `markFailedBeforeSigning(${paymentId})`,
  );
}

/**
 * Keeps the budget consumed for a payment that was signed but whose outcome we
 * could not confirm. Fails closed: we assume the money moved, because a signed
 * authorization remains spendable whether or not we saw the response.
 */
export function markUnreconciled(paymentId: string, detail: string): void {
  applyTransition(
    `UPDATE payments SET status = 'unreconciled', detail = ?
     WHERE id = ? AND status IN (${IN_FLIGHT.map((s) => `'${s}'`).join(", ")})`,
    [detail.slice(0, 500), paymentId],
    `markUnreconciled(${paymentId})`,
  );
}

/**
 * Records a human's finding about a payment Fuel could not confirm on its own.
 *
 * WHY THIS IS AN ATTESTATION AND NOT A LOOKUP, WHICH IS THE ASYMMETRY WORTH
 * UNDERSTANDING. The inbound side can ask the chain directly: a receipt stores
 * `payer_address` and `authorization_nonce` — it has to, they are its replay
 * key — so `authorizationState(authorizer, nonce)` answers "did this move
 * money" exactly, and `src/gateway/settlement-evidence.ts` does precisely that.
 *
 * A payment row stores neither. It has an amount, a resource URL and a
 * `tx_hash` that is NULL in exactly the case we care about. There is no nonce
 * to ask about and no recorded payee to look for, so the same question is not
 * answerable from what is stored. The available alternatives are heuristics —
 * match a `Transfer` of the right size in a time window — and a heuristic
 * mis-attributes the moment an agent makes two identical payments. Booking the
 * wrong one is worse than booking neither, because this entire status
 * vocabulary exists to stop "we do not know" collapsing into a guess.
 *
 * So the operator establishes the outcome out of band and records it here, and
 * `detail` is REQUIRED so the record says a person asserted this rather than
 * that Fuel observed it. The same discipline 0008 arrived at for currency:
 * "verified" must mean verified, and an assumption must never be stored wearing
 * a verification's clothes.
 *
 * `failed` releases the budget, and that is sound rather than a stretch of the
 * word. The schema comment for `failed` leads with "failed BEFORE anything was
 * signed", but the load-bearing half is the clause after it — "no spendable
 * authorization exists". An EIP-3009 authorization that has passed its
 * `validBefore` unused satisfies that exactly: it is dead, it can never be
 * spent, and holding budget against it forever is simply wrong.
 *
 * Returns false when nothing changed, so a double-submit is a 409 rather than a
 * silent second write.
 */
export type ReconcileRefusal = "not-unreconciled" | "authorization-still-live";

export interface ReconcileOutcome {
  ok: boolean;
  refusal?: ReconcileRefusal;
  /** How the release was justified. Never claims a check that did not happen. */
  basis?: "authorization expired" | "expiry not recorded" | "operator attestation";
  validBefore?: number | null;
}

/**
 * Records the authorization window Fuel actually signed.
 *
 * Written from the SIGNED PAYLOAD rather than recomputed from the terms that
 * were requested, for the same reason `payForAgent` re-reads
 * `authorization.value` instead of trusting the amount it asked for: what
 * matters is what was signed, not what was intended.
 */
export function recordAuthorizationWindow(paymentId: string, validBefore: number): void {
  db.prepare(
    `UPDATE payments SET authorization_valid_before = ?
     WHERE id = ? AND authorization_valid_before IS NULL`,
  ).run(validBefore, paymentId);
}

/** The signed expiry, or null for a row written before 6B-2 recorded one. */
export function authorizationValidBefore(paymentId: string): number | null {
  const row = db
    .prepare("SELECT authorization_valid_before AS v FROM payments WHERE id = ?")
    .get(paymentId) as unknown as { v: number | null } | undefined;
  return row?.v ?? null;
}

export function reconcileUnreconciledPayment(params: {
  paymentId: string;
  outcome: "settled" | "failed";
  detail: string;
  txHash?: string | null;
  /** Clock injection, for the verification suite only. */
  nowSeconds?: number;
}): ReconcileOutcome {
  const { paymentId, outcome, detail, txHash } = params;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const validBefore = authorizationValidBefore(paymentId);

  /*
   * THE CHECK THAT MAKES A BUDGET RELEASE SOUND, and the reason `failed` is
   * not simply an operator's word.
   *
   * `failed` means "no spendable authorization exists", and releasing budget
   * on that basis is only true when it is true. An EIP-3009 authorization stays
   * spendable by the facilitator until its `validBefore` no matter what Fuel's
   * own HTTP request did — so releasing budget while that window is open lets
   * the agent spend again against a cap that is now wrong, and if the
   * authorization later settles, nothing revisits the row: `markSettled`'s
   * guard no longer matches `failed`, and there is no outbound settlement
   * poller. The overspend would be silent and permanent.
   *
   * So while a recorded window is still open this refuses outright. A human
   * cannot attest their way past it, because the chain does not care what a
   * human believes.
   */
  if (outcome === "failed" && validBefore !== null && now < validBefore) {
    return { ok: false, refusal: "authorization-still-live", validBefore };
  }

  const settledAt = outcome === "settled" ? new Date().toISOString() : null;
  const { changes } = db
    .prepare(
      `UPDATE payments SET status = ?, tx_hash = ?, detail = ?, settled_at = ?
       WHERE id = ? AND status = 'unreconciled'`,
    )
    .run(outcome, txHash ?? null, detail.slice(0, 500), settledAt, paymentId);

  if (Number(changes) === 0) return { ok: false, refusal: "not-unreconciled" };

  return {
    ok: true,
    validBefore,
    basis:
      outcome === "settled"
        ? "operator attestation"
        : validBefore === null
          // Honest about what was NOT checked. Every row signed before 6B-2 is
          // in this bucket; refusing them outright would recreate the permanent
          // dead end this whole slice exists to remove.
          ? "expiry not recorded"
          : "authorization expired",
  };
}

/** Payments that were signed and never confirmed, oldest first, company-scoped. */
export function paymentsNeedingAttention(companyId: string): {
  id: string;
  agentId: string;
  agentName: string;
  amountBaseUnits: bigint;
  detail: string | null;
  createdAt: string;
}[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.agent_id, a.name AS agent_name, p.amount_base_units, p.detail, p.created_at
       FROM payments p
       JOIN agents a ON a.id = p.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE t.company_id = ? AND p.status = 'unreconciled'
       ORDER BY p.created_at ASC, p.id ASC`,
    )
    .all(companyId) as unknown as {
    id: string;
    agent_id: string;
    agent_name: string;
    amount_base_units: number | bigint;
    detail: string | null;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    amountBaseUnits: BigInt(r.amount_base_units),
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

/**
 * Resolves reservations abandoned by a crash, so their budget is not held
 * forever by a request that will never finish.
 *
 * The two cases are deliberately not treated alike, which is what the
 * `signing` status buys us:
 *
 *   pending → failed        Signing was never reached, so no authorization can
 *                           exist and the budget is genuinely free.
 *   signing → unreconciled  An authorization may exist and stay spendable
 *                           until it expires. Keep the budget consumed; the
 *                           same call a live request makes when it fails after
 *                           signing.
 *
 * Each UPDATE re-checks the status it expects in its WHERE clause, so if the
 * real request resolves the row first, the reaper matches nothing rather than
 * overwriting a real outcome.
 */
export function reapStaleReservations(staleMs: number): { released: number; unreconciled: number } {
  const cutoff = new Date(Date.now() - staleMs).toISOString();

  // One transaction, so a crash between the two cannot apply the half that
  // releases budget without the half that holds it.
  db.exec("BEGIN IMMEDIATE");
  try {
    const released = db
      .prepare(
        `UPDATE payments SET status = 'failed', detail = ?
         WHERE status = 'pending' AND created_at < ?`,
      )
      .run("abandoned before signing; reservation released", cutoff).changes;

    const unreconciled = db
      .prepare(
        `UPDATE payments SET status = 'unreconciled', detail = ?
         WHERE status = 'signing' AND created_at < ?`,
      )
      .run("abandoned while signing; assuming the authorization is spendable", cutoff).changes;

    db.exec("COMMIT");
    return { released: Number(released), unreconciled: Number(unreconciled) };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  }
}

export function listPayments(agentId: string): Payment[] {
  const rows = db
    .prepare("SELECT * FROM payments WHERE agent_id = ? ORDER BY created_at DESC")
    .all(agentId) as unknown as PaymentRow[];
  return rows.map(toPayment);
}

/** A payment joined to its agent's name, with the date the ledger dates it by. */
export interface PaymentExportRow extends Payment {
  agentName: string;
  /**
   * `settled_at` when known, else `created_at`. Computed in SQL rather than in
   * TypeScript so that the value emitted is the exact expression that was
   * filtered and sorted on — computing it twice is how a row ends up outside
   * the range the caller asked for.
   */
  ledgerDate: string;
}

/**
 * Every payment in a date range, oldest first, for the accounting export.
 *
 * Ordered ascending, unlike every other listing in this file: a ledger reads
 * forwards in time. Not paginated, because an accounting export is defined by
 * its date range rather than by a page — the caller bounds it with from/to.
 *
 * Spans all agents in all teams. There is one company today; when there are
 * more, this needs a company_id filter or it becomes a cross-tenant leak.
 */
export function listPaymentsForExport(opts: {
  /**
   * REQUIRED, and first, so no caller reaches this without having decided
   * whose books it is writing.
   *
   * This predicate was missing until 5B-3, and its absence was the worst
   * placement of that bug in the codebase: an export is the one surface whose
   * output LEAVES Fuel permanently and lands in a third party's accounting
   * system. A second company's payments appearing in the file would not be a
   * read someone might notice and discard — it would be a row in a customer's
   * books, reconciled, filed, and possibly on a tax return.
   *
   * Same standing caveat as listPaymentsPage: a query seam, not tenant
   * isolation, because the operator credential resolves a role and not a
   * tenant. What it buys is that the day a second company exists, this file
   * does not silently widen to include it.
   */
  companyId: string;
  from?: string;
  to?: string;
  includeAll?: boolean;
}): PaymentExportRow[] {
  // The one expression that defines a row's ledger date. Repeated in SELECT,
  // WHERE and ORDER BY, so it is named once here.
  const LEDGER_DATE = "COALESCE(p.settled_at, p.created_at)";

  // First in the array, so the scope predicate is present in every query this
  // function can build rather than depending on a later branch being taken.
  const where: string[] = ["t.company_id = ?"];
  const params: string[] = [opts.companyId];

  if (!opts.includeAll) where.push(`p.status IN ${APPEARS_IN_LEDGER}`);

  // Both bounds are inclusive whole days. Comparing ISO strings lexicographically
  // is safe here for the reason velocity.ts relies on: every timestamp in this
  // column is a fixed-width UTC toISOString() with exactly three fractional
  // digits, and none is client-supplied. That fixed width is what makes
  // '…T23:59:59.999Z' a true upper bound rather than an approximate one.
  if (opts.from) {
    where.push(`${LEDGER_DATE} >= ?`);
    params.push(opts.from);
  }
  if (opts.to) {
    where.push(`${LEDGER_DATE} <= ?`);
    params.push(`${opts.to}T23:59:59.999Z`);
  }

  const rows = db
    .prepare(
      // The teams join exists only to reach company_id. It drops no rows:
      // agents.team_id is NOT NULL REFERENCES teams(id), so every payment has
      // exactly one company. An inner join that could lose rows would be the
      // wrong tool here — an export that silently omits payments understates
      // spend, which is the more dangerous direction for a ledger to be wrong.
      `SELECT p.*, a.name AS agent_name, ${LEDGER_DATE} AS ledger_date
       FROM payments p
       JOIN agents a ON a.id = p.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${LEDGER_DATE} ASC, p.id ASC`,
    )
    .all(...(params as never[])) as unknown as (PaymentRow & {
    agent_name: string;
    ledger_date: string;
  })[];

  return rows.map((row) => ({
    ...toPayment(row),
    agentName: row.agent_name,
    ledgerDate: row.ledger_date,
  }));
}

/* -------------------------------------------------------------------------
 * The Activity Ledger read used to live here.
 *
 * It moved to db/ledger.ts in 6B-3, when it stopped being a payments query.
 * The ledger now merges both directions, and a UNION over payments and receipts
 * built inside this file would put the receipts table within one import of the
 * cap sums above — which the header of receipts.ts argues at length must not be
 * possible. Nothing here pages payments alone any more; there is one ledger
 * pager and it lives next to neither table.
 * ---------------------------------------------------------------------- */

/**
 * Whether an id names an agent inside this company.
 *
 * Its own company-joined query rather than a reuse of getAgentUnscoped(), which looks
 * up by id alone. Validating with the global lookup would answer "does this
 * exist" when the question is "may this caller filter by it" — the page query's
 * own predicate would still keep the rows out, but the caller would get an
 * empty page instead of the 400 that tells them their filter was wrong.
 */
export function agentInCompany(agentId: string, companyId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM agents a JOIN teams t ON t.id = a.team_id
       WHERE a.id = ? AND t.company_id = ?`,
    )
    .get(agentId, companyId);
  return row !== undefined;
}

export function teamInCompany(teamId: string, companyId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM teams WHERE id = ? AND company_id = ?")
    .get(teamId, companyId);
  return row !== undefined;
}

/**
 * One payment's status, scoped to a company.
 *
 * Company-joined for the same reason `agentInCompany` is, and here it also
 * decides a response code: an id belonging to another company must be
 * indistinguishable from one that does not exist, or the 404/409 split becomes
 * a way to probe whether an id is real. Returns only the status, because the
 * one caller is the reconcile route and a wider shape would invite a spread.
 */
export function getPaymentStatusInCompany(
  paymentId: string,
  companyId: string,
): PaymentStatus | null {
  const row = db
    .prepare(
      `SELECT p.status FROM payments p
       JOIN agents a ON a.id = p.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE p.id = ? AND t.company_id = ?`,
    )
    .get(paymentId, companyId) as unknown as { status: string } | undefined;
  return row ? (row.status as PaymentStatus) : null;
}

/**
 * The most recent payments for one agent, bounded.
 *
 * `listPayments` returns an agent's entire history — 220 rows for the busiest
 * agent in the current database — which GET /api/agents/:id was returning
 * whole. A bounded read with the total alongside it lets that route say how
 * much it is showing instead of truncating silently.
 */
export function listRecentPayments(
  agentId: string,
  limit: number,
): { rows: Payment[]; total: number } {
  const rows = db
    .prepare("SELECT * FROM payments WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(agentId, limit) as unknown as PaymentRow[];
  const { total } = db
    .prepare("SELECT COUNT(*) AS total FROM payments WHERE agent_id = ?")
    .get(agentId) as unknown as { total: number };
  return { rows: rows.map(toPayment), total };
}
