/**
 * Approval requests: a payment the team or company ceiling refused, held for a
 * human to approve or deny.
 *
 * An approval is a ONE-TIME EXEMPTION, not a cap change. Approving lets exactly
 * one payment through above the ceiling that blocked it; the cap value itself
 * is untouched, and the resulting spend still counts toward every total, so the
 * next unapproved payment is refused just as before. The cost of that choice,
 * accepted deliberately: total spend can exceed a cap, so `spent <= cap` is not
 * an invariant — every overage instead traces to a named approval row.
 *
 * The redemption itself does NOT live here. It happens inside
 * `reserveIfUnderCap` (src/db/payments.ts), in the same transaction that
 * reserves the payment's budget, because that is the only way two concurrent
 * retries carrying one approval id cannot both pay.
 */
import { randomUUID } from "node:crypto";
import { db } from "./index.js";
import { activeUserCount } from "./users.js";

/**
 * How long an approval stays redeemable.
 *
 * Short on purpose: redemption re-fetches the merchant's terms and signs fresh
 * (a signature cannot wait for a human — see src/payments/limits.ts), so a
 * stale approval would execute against a price nobody looked at. Long enough
 * that an agent on a slow retry loop still catches it.
 */
export const APPROVAL_VALIDITY_MS = 15 * 60 * 1000;

/** How long an un-acted-on request sits in the queue before it is dropped. */
export const PENDING_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

/**
 * What the request is asking permission for — and therefore what approving it
 * exempts.
 *
 * Only the ceilings ABOVE the agent produce cap approvals — never the agent's
 * own. `anomaly` is not a ceiling at all: the payment passed every cap and was
 * held because its size was out of character for the agent
 * (src/payments/anomaly.ts). Approving one exempts only the anomaly rule; every
 * cap still applies. See the redemption branch in reserveIfUnderCap.
 */
export type ApprovableScope = "team" | "company" | "anomaly";

export interface ApprovalRequest {
  id: string;
  agentId: string;
  amountBaseUnits: bigint;
  resourceUrl: string;
  blockedScope: ApprovableScope;
  status: ApprovalStatus;
  approvalExpiresAt: string | null;
  paymentId: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** The user who decided it. NULL means a shared key did — see src/db/index.ts. */
  decidedBy: string | null;
  detail: string | null;
  /** Seeded by scripts/seed-demo-day.ts. No production path can set it. */
  isDemo: boolean;
}

interface ApprovalRow {
  id: string;
  agent_id: string;
  amount_base_units: number | bigint;
  resource_url: string;
  blocked_scope: ApprovableScope;
  status: ApprovalStatus;
  approval_expires_at: string | null;
  payment_id: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  detail: string | null;
  is_demo: number | bigint;
}

function toApprovalRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    agentId: row.agent_id,
    amountBaseUnits: BigInt(row.amount_base_units),
    resourceUrl: row.resource_url,
    blockedScope: row.blocked_scope,
    status: row.status,
    approvalExpiresAt: row.approval_expires_at,
    paymentId: row.payment_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    detail: row.detail,
    isDemo: Number(row.is_demo) === 1,
  };
}

/**
 * Records a refused payment for a human to decide on.
 *
 * Returns an existing `pending` request for the same agent, url, amount AND
 * scope rather than stacking duplicates — an agent retrying in a loop should
 * not bury an operator in identical rows to click through. This only collapses
 * requests that are pending *simultaneously*: once one is consumed or denied,
 * the next attempt creates a fresh one, so an agent that legitimately pays the
 * same endpoint repeatedly still needs an approval for each payment.
 *
 * `blockedScope` is part of that key, and has to be. It was harmless to omit
 * while every approval bought the same exemption, but an approval's scope now
 * decides what redemption skips — so reusing a pending `team` row for what is
 * actually an anomaly refusal would hand that payment a team/company cap
 * bypass nobody granted. That is reachable without malice: a payment blocked by
 * the team ceiling, the ceiling then raised, the same payment retried and this
 * time flagged as unusual. Keying on scope keeps a row's label matching the
 * refusal that produced it, which is what the redemption branch trusts.
 */
export function createApprovalRequest(params: {
  agentId: string;
  amountBaseUnits: bigint;
  resourceUrl: string;
  blockedScope: ApprovableScope;
  /**
   * Why this was held, in words, for the operator deciding it. An anomaly is
   * not self-explanatory the way "over the team cap" is — without the baseline
   * and the threshold there is nothing to judge, and approving becomes a rubber
   * stamp. Note the reaper overwrites this on expiry; the `blocked` payment row
   * keeps its own copy.
   */
  detail?: string;
}): ApprovalRequest {
  const existing = db
    .prepare(
      `SELECT * FROM approval_requests
       WHERE agent_id = ? AND resource_url = ? AND amount_base_units = ?
         AND blocked_scope = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(
      params.agentId,
      params.resourceUrl,
      params.amountBaseUnits,
      params.blockedScope,
    ) as ApprovalRow | undefined;
  if (existing) return toApprovalRequest(existing);

  const id = randomUUID();
  db.prepare(
    `INSERT INTO approval_requests
       (id, agent_id, amount_base_units, resource_url, blocked_scope, status, created_at, detail)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    params.agentId,
    params.amountBaseUnits,
    params.resourceUrl,
    params.blockedScope,
    new Date().toISOString(),
    params.detail?.slice(0, 500) ?? null,
  );
  return getApprovalRequestUnscoped(id)!;
}

export function getApprovalRequestUnscoped(id: string): ApprovalRequest | null {
  const row = db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as
    | ApprovalRow
    | undefined;
  return row ? toApprovalRequest(row) : null;
}

/* -------------------------------------------------------------------------
 * Company-scoped reads.
 *
 * An approval has no company_id of its own. It reaches one the same way a
 * payment does — approval_requests -> agents -> teams -> teams.company_id —
 * and that chain is total: `agents.team_id` is NOT NULL REFERENCES teams(id),
 * so an inner join drops no rows. That matters more than it looks. A scoping
 * join that silently discarded approvals would hide held payments from the
 * only people who can release them.
 *
 * Same standing caveat as listPaymentsPage: this is a QUERY SEAM, not tenant
 * isolation. src/lib/auth.ts resolves a role, never a tenant, so the predicate
 * cannot stop a credential holder reading another company's rows — there is
 * one company and no way to tell two operators apart. What it buys is that the
 * day a second company exists, these routes do not silently widen.
 * ---------------------------------------------------------------------- */

/**
 * An approval plus the names a surface needs to render it without a second
 * lookup — and without the caller having to fetch every agent to resolve one
 * id, which is what the dashboard did before.
 */
export interface ApprovalRequestWithContext extends ApprovalRequest {
  agentName: string;
  teamId: string;
  teamName: string;
  /**
   * The address of the person who decided it, or null.
   *
   * THE POINT OF THE COLUMN IS THAT SOMEBODY CAN READ IT. `decidedBy` holds a
   * user id, which answers nobody's question — an operator looking at a queue
   * wants a name, and a UUID is not one. Resolved in the same query rather than
   * looked up per row, so a list of twenty approvals is still one statement.
   *
   * Null covers both "a shared key decided this" and "nobody has decided it
   * yet", which are distinguishable from `status` and `decidedAt` beside it.
   */
  decidedByEmail: string | null;
}

type ApprovalContextRow = ApprovalRow & {
  agent_name: string;
  team_id: string;
  team_name: string;
  decided_by_email: string | null;
};

function toApprovalWithContext(row: ApprovalContextRow): ApprovalRequestWithContext {
  return {
    ...toApprovalRequest(row),
    agentName: row.agent_name,
    teamId: row.team_id,
    teamName: row.team_name,
    decidedByEmail: row.decided_by_email,
  };
}

/** The join every scoped read shares, named once so the predicate cannot drift. */
const IN_COMPANY = `
  FROM approval_requests r
  JOIN agents a ON a.id = r.agent_id
  JOIN teams  t ON t.id = a.team_id
  -- LEFT, because most rows have no decider: every approval still pending, and
  -- every one a shared key decided. An inner join here would silently drop
  -- exactly the rows an operator most needs to see.
  --
  -- The company predicate on the user is redundant today — a decision is
  -- already company-scoped, so the decider cannot belong elsewhere — and it is
  -- here anyway, so that the only way another company's address could surface
  -- in this response is if someone deliberately removed this line.
  LEFT JOIN users u ON u.id = r.decided_by AND u.company_id = t.company_id
  WHERE t.company_id = ?`;

const CONTEXT_COLUMNS =
  `r.*, a.name AS agent_name, t.id AS team_id, t.name AS team_name, u.email AS decided_by_email`;

/**
 * Every approval in one company, newest first.
 *
 * `companyId` is required and first, so a caller cannot reach this without
 * having decided whose data it is asking for — the same shape as
 * PaymentsPageOptions. An optional parameter would make the unscoped read the
 * easy one to write by accident.
 *
 * Deliberately unpaginated, unlike the payments ledger. An approval row is
 * created only when a ceiling refuses a payment, so the table grows with
 * exceptions rather than with traffic (20 rows against 267 payments today),
 * and the dashboard counts pending work across the whole set. If that stops
 * being true, listPaymentsPage is the model to copy — keyset over
 * (created_at, id), not OFFSET.
 */
export function listApprovalRequests(opts: {
  companyId: string;
  status?: ApprovalStatus;
}): ApprovalRequestWithContext[] {
  const where = opts.status === undefined ? "" : " AND r.status = ?";
  const params = opts.status === undefined ? [opts.companyId] : [opts.companyId, opts.status];
  const rows = db
    .prepare(
      `SELECT ${CONTEXT_COLUMNS} ${IN_COMPANY}${where}
       ORDER BY r.created_at DESC, r.id DESC`,
    )
    .all(...(params as never[])) as unknown as ApprovalContextRow[];
  return rows.map(toApprovalWithContext);
}

/**
 * One approval, but only if it belongs to this company.
 *
 * Its own scoped query rather than getApprovalRequestUnscoped() plus a check
 * afterwards: an id that exists elsewhere and an id that does not exist both
 * have to answer 404, and doing the scoping in SQL is what makes that true by
 * construction rather than by remembering to write the second branch.
 */
export function getApprovalRequestInCompany(
  id: string,
  companyId: string,
): ApprovalRequestWithContext | null {
  const row = db
    .prepare(`SELECT ${CONTEXT_COLUMNS} ${IN_COMPANY} AND r.id = ?`)
    .get(companyId, id) as ApprovalContextRow | undefined;
  return row ? toApprovalWithContext(row) : null;
}

/**
 * A human's decision. Guarded on `pending` so a second decision — or a
 * decision racing the reaper's expiry — cannot overwrite the first.
 *
 * Returns null when nothing changed, which the API turns into a 409 rather
 * than reporting a decision that did not happen.
 */
/**
 * A shared key tried to decide for a company where real people exist.
 *
 * Its own error type rather than a boolean, because the route has to tell this
 * apart from "already decided" and answer differently: one is a credential that
 * may not do this, the other is a request that is no longer pending.
 */
export class SharedKeyCannotDecideError extends Error {
  constructor() {
    super(
      "this company has people who sign in, so a shared API key may no longer approve or deny " +
        "its payments — sign in and decide as yourself, so the decision has a name on it",
    );
    this.name = "SharedKeyCannotDecideError";
  }
}

/**
 * Approve or deny one held payment, recording WHO did it.
 *
 * ONE FUNCTION WHERE THERE WERE TWO. `approveRequest` and `denyRequest` were
 * near-identical UPDATEs; they are now one, because Stage 3 gives them a shared
 * precondition that must not be duplicated. Two copies of a refusal are two
 * chances for one to be forgotten — and the one that would be forgotten is
 * `deny`, since approving is what everyone thinks of as the dangerous verb. A
 * denial is equally a two-party-control decision.
 *
 * WHY THE WHOLE THING IS ONE TRANSACTION. The refusal below is a check-then-act:
 * read whether the company has accounts, then write the decision. That is
 * exactly the shape this stage has been bitten by twice, and split across two
 * statements it would have a real window — a company could gain its first
 * account between the check and the write, and a shared key would slip a
 * nameless decision in underneath it. `BEGIN IMMEDIATE` takes the write lock up
 * front, so no other writer (signup included, which uses the same pattern)
 * can interleave.
 *
 * `decidedBy` IS THE WHOLE POINT, AND IT IS WRITTEN IN THE SAME UPDATE as the
 * status rather than a second one, so the row can never say that one person
 * decided it while carrying another person's name. See the race test in
 * scripts/verify-migration.ts: with the write split in two, the loser of a
 * collision overwrites the winner's name, and the audit trail then credits the
 * decision to somebody who did not make it.
 *
 * Returns null when nothing changed — already decided, consumed or expired,
 * including when another operator won the race a moment earlier. Throws
 * SharedKeyCannotDecideError when a nameless credential may not decide at all.
 */
export function decideRequest(params: {
  id: string;
  companyId: string;
  decision: "approve" | "deny";
  /**
   * The user making the decision, or null for a shared key.
   *
   * Null is the signal the refusal turns on, and it is the right signal rather
   * than a convenient one: the property that matters is "this decision cannot
   * be attributed to anybody", and a null id IS that property. A future
   * credential type that names no person would be refused here too, which is
   * the safe direction to fail in.
   */
  decidedBy: string | null;
}): ApprovalRequest | null {
  const now = new Date();
  const decidedAt = now.toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    if (params.decidedBy === null && activeUserCount(params.companyId) > 0) {
      throw new SharedKeyCannotDecideError();
    }

    /*
     * Two statements written out in full rather than one assembled from
     * fragments. The first draft of this built one prepared statement and
     * varied its bound parameters by branch, which is how a positional
     * argument ends up in the wrong slot on a money path with nothing to
     * catch it. Duplication is cheaper than that.
     *
     * The deny branch sets approval_expires_at to NULL explicitly. A pending
     * row holds no expiry, so today it changes nothing — it is there to state
     * the invariant the race test checks: a refused payment must not come out
     * of a collision still carrying a live permission to spend.
     */
    const changes =
      params.decision === "approve"
        ? db
            .prepare(
              `UPDATE approval_requests
                  SET status = 'approved', decided_at = ?, decided_by = ?, approval_expires_at = ?
                WHERE id = ? AND status = 'pending'`,
            )
            .run(
              decidedAt,
              params.decidedBy,
              new Date(now.getTime() + APPROVAL_VALIDITY_MS).toISOString(),
              params.id,
            ).changes
        : db
            .prepare(
              `UPDATE approval_requests
                  SET status = 'denied', decided_at = ?, decided_by = ?, approval_expires_at = NULL
                WHERE id = ? AND status = 'pending'`,
            )
            .run(decidedAt, params.decidedBy, params.id).changes;

    const decided = Number(changes) === 0 ? null : getApprovalRequestUnscoped(params.id);
    db.exec("COMMIT");
    return decided;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Expires approvals nobody redeemed and requests nobody decided.
 *
 * Both UPDATEs share one transaction and each re-checks the status it expects,
 * so a decision or redemption arriving concurrently is never overwritten — the
 * same discipline reapStaleReservations uses for payments.
 *
 * Expiring an approval can only ever REMOVE permission to spend, so unlike the
 * payment reaper there is no fail-open direction to get wrong here.
 */
export function reapStaleApprovals(): { expiredApprovals: number; expiredPending: number } {
  const now = new Date();
  const pendingCutoff = new Date(now.getTime() - PENDING_APPROVAL_TTL_MS).toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    const expiredApprovals = db
      .prepare(
        `UPDATE approval_requests SET status = 'expired', detail = ?
         WHERE status = 'approved' AND approval_expires_at IS NOT NULL
           AND approval_expires_at < ?`,
      )
      .run("approved but not redeemed before it expired", now.toISOString()).changes;

    const expiredPending = db
      .prepare(
        `UPDATE approval_requests SET status = 'expired', detail = ?
         WHERE status = 'pending' AND created_at < ?`,
      )
      .run("no decision was made in time", pendingCutoff).changes;

    db.exec("COMMIT");
    return {
      expiredApprovals: Number(expiredApprovals),
      expiredPending: Number(expiredPending),
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  }
}
