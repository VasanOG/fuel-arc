/**
 * Money arriving, as distinct from money leaving.
 *
 * WHY THIS IS NOT A COLUMN ON `payments`. The two directions fail closed in
 * opposite directions, and one table cannot hold both without a discriminator
 * every reader has to remember to check.
 *
 * Outbound, when Fuel does not know what happened, it must assume the money
 * LEFT: an EIP-3009 authorization is spendable until it expires, so
 * `unreconciled` keeps the budget consumed. Being wrong in that direction
 * costs a rejected payment.
 *
 * Inbound, the cautious assumption is the exact inverse — assume the money did
 * NOT arrive. Unconfirmed revenue booked into a customer's accounts overstates
 * what they earned, and it leaves the system permanently once posted. Being
 * wrong in that direction misstates someone's books.
 *
 * A separate table also makes a policy decision structural instead of
 * remembered: `COUNTS_AGAINST_CAP` in payments.ts is interpolated into the cap
 * queries, and under a shared table every one of those would need a direction
 * predicate that a future query could omit. A receipt is not a payment, so it
 * cannot reach a cap query at all. Earning therefore cannot raise what an
 * agent may spend — enforced by the schema rather than by vigilance.
 *
 * See docs/decisions/0011-the-earning-side.md.
 */
import { randomUUID } from "node:crypto";
import { db } from "./index.js";

/**
 * Every status an inbound payment can hold.
 *
 * REASONED FROM THE INBOUND DIRECTION, NOT MIRRORED FROM `PaymentStatus`.
 * Symmetry would be the wrong instinct: each outbound status was argued for a
 * payer that had already signed something spendable, which is not the
 * situation on this side of the wire.
 *
 *   awaiting          Payment verified and a row claimed, but the origin has
 *                     not been called yet. Also the crash marker: a process
 *                     that dies mid-request leaves the row here, which is why
 *                     `reapStaleAwaiting` exists.
 *
 *   abandoned         The origin failed, timed out, or refused. NOTHING WAS
 *                     SETTLED — the gateway skips settlement entirely when it
 *                     cannot deliver, so the payer is not charged at all. This
 *                     is the common failure and it costs nobody anything.
 *
 *   served_unsettled  The origin served, and settlement then definitively
 *                     failed. THE EXPOSURE STATE, and the reason this
 *                     vocabulary could not be copied: it has no outbound
 *                     analogue, because outbound Fuel is the one who pays
 *                     rather than the one who delivers first. The customer's
 *                     compute was spent and no money arrived.
 *
 *   settle_unknown    The origin served and the settle call THREW. The
 *                     facilitator raises a plain Error on a network failure,
 *                     which is indistinguishable from a settlement that landed
 *                     — so the money may or may not have moved. This is the
 *                     inbound analogue of `unreconciled`, and it exists
 *                     because "we do not know" must never be collapsed into
 *                     "it failed." Not booked, per the fail-closed direction
 *                     above; reconcilable later against the chain.
 *
 *   settled           Settlement confirmed. Money genuinely arrived.
 *
 * There is no `blocked`: Fuel does not refuse inbound money on a policy basis,
 * because there is no inbound cap. If that ever changes it is a new status with
 * its own argument, not a reuse of one of these.
 */
export type ReceiptStatus =
  | "awaiting"
  | "abandoned"
  | "served_unsettled"
  | "settle_unknown"
  | "settled";

export const RECEIPT_STATUSES: ReceiptStatus[] = [
  "awaiting",
  "abandoned",
  "served_unsettled",
  "settle_unknown",
  "settled",
];

/**
 * The statuses that belong in an accounting ledger.
 *
 * ONLY `settled`, and the asymmetry with APPEARS_IN_LEDGER is the point rather
 * than an oversight. Outbound includes `unreconciled` — money that may have
 * moved — because omitting a real exposure would understate what is owed, and
 * a suspense account is the standard home for an amount whose classification
 * is not yet known.
 *
 * Inbound inverts the reasoning, so there is deliberately NO revenue-suspense
 * class. `served_unsettled` and `settle_unknown` are both genuine exposures,
 * but recording either as revenue would overstate what the customer earned,
 * and "provisional income" is not a thing an accountant can act on the way
 * provisional cost is. They stay out of the books and stay visible in Fuel.
 *
 * Exported so db/postings.ts filters on the SAME set rather than a second copy
 * that could drift — the same discipline APPEARS_IN_LEDGER already enforces.
 */
export const APPEARS_IN_RECEIPT_LEDGER = "('settled')";

export interface Receipt {
  id: string;
  agentId: string;
  endpointId: string | null;
  amountBaseUnits: bigint;
  status: ReceiptStatus;
  payerAddress: string;
  authorizationNonce: string;
  txHash: string | null;
  detail: string | null;
  createdAt: string;
  settledAt: string | null;
}

interface ReceiptRow {
  id: string;
  agent_id: string;
  endpoint_id: string | null;
  amount_base_units: number | bigint;
  status: string;
  payer_address: string;
  authorization_nonce: string;
  tx_hash: string | null;
  detail: string | null;
  created_at: string;
  settled_at: string | null;
}

function toReceipt(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    agentId: row.agent_id,
    endpointId: row.endpoint_id,
    amountBaseUnits: BigInt(row.amount_base_units),
    status: row.status as ReceiptStatus,
    payerAddress: row.payer_address,
    authorizationNonce: row.authorization_nonce,
    txHash: row.tx_hash,
    detail: row.detail,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

/** A replay: this payer has already used this authorization nonce. */
export class DuplicateAuthorizationError extends Error {
  constructor() {
    super("This payment authorization has already been used. Sign a fresh one.");
    this.name = "DuplicateAuthorizationError";
  }
}

/**
 * Claims a receipt for a verified payment, or refuses it as a replay.
 *
 * THIS INSERT IS THE REPLAY DEFENCE, and it has to run before the origin is
 * touched. The x402 resource-server path has no nonce store, no idempotency,
 * and no dedup of any kind: `verify` is not binding, so N concurrent requests
 * carrying one signed payload all pass verification. Without this, all N would
 * reach the customer's origin and N-1 settlements would then fail with
 * `nonce_already_used` — after the work was already done, N times.
 *
 * THE SERIALISATION IS THE SYNCHRONOUS INSERT, AND THAT IS AN INVARIANT, NOT
 * AN ACCIDENT. `node:sqlite`'s DatabaseSync is synchronous and Node is
 * single-threaded, so this statement cannot interleave with another request's
 * JavaScript. Two concurrent replays both pass verify, both arrive here, and
 * exactly one wins the UNIQUE constraint.
 *
 * That holds ONLY while nothing awaits between verify resolving and this call.
 * An async pre-check, an audit write, a metrics flush added in that gap would
 * reopen the amplification silently — the tests would still pass, because the
 * race needs concurrency to show. If you add an await before this line, you
 * have broken it.
 *
 * Verify deliberately comes FIRST, though. Claiming the row before verifying
 * would let anyone burn a victim's nonce slot by posting an unsigned payload
 * with their address in it.
 */
export function claimReceipt(params: {
  agentId: string;
  endpointId: string;
  amountBaseUnits: bigint;
  payerAddress: string;
  authorizationNonce: string;
}): Receipt {
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO receipts
         (id, agent_id, endpoint_id, amount_base_units, status,
          payer_address, authorization_nonce, created_at)
       VALUES (?, ?, ?, ?, 'awaiting', ?, ?, ?)`,
    ).run(
      id,
      params.agentId,
      params.endpointId,
      params.amountBaseUnits,
      // Lowercased so two spellings of one address cannot both claim a nonce.
      params.payerAddress.toLowerCase(),
      params.authorizationNonce.toLowerCase(),
      now,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) throw new DuplicateAuthorizationError();
    throw error;
  }
  return getReceiptUnscoped(id)!;
}

/** A receipt, only if its agent belongs to this company. Scoped in the query, so another company's id and a nonexistent id both come back null — the route's 404 is produced by the SQL, not by a branch someone remembered to write. Same construction as getAgentInCompany. */
export function getReceiptInCompany(id: string, companyId: string): Receipt | null {
  const row = db
    .prepare(
      `SELECT r.* FROM receipts r
         JOIN agents a ON a.id = r.agent_id
         JOIN teams  t ON t.id = a.team_id
        WHERE r.id = ? AND t.company_id = ?`,
    )
    .get(id, companyId) as unknown as ReceiptRow | undefined;
  return row ? toReceipt(row) : null;
}

/**
 * A receipt by id, UNSCOPED. Internal re-reads and the gateway's own writes
 * only; the suffix is the warning, and scripts/verify-api.ts asserts no
 * route-facing file calls anything ending in it.
 */
export function getReceiptUnscoped(id: string): Receipt | null {
  const row = db.prepare("SELECT * FROM receipts WHERE id = ?").get(id) as
    | unknown as ReceiptRow
    | undefined;
  return row ? toReceipt(row) : null;
}

/**
 * Moves a claimed receipt to a terminal state.
 *
 * One write path for every outcome rather than four near-identical ones, and a
 * guard on the current status so a late-returning request cannot overwrite a
 * terminal row the reaper already resolved.
 */
export function resolveReceipt(
  id: string,
  status: Exclude<ReceiptStatus, "awaiting">,
  fields: { txHash?: string | null; detail?: string | null } = {},
): void {
  const settledAt = status === "settled" ? new Date().toISOString() : null;
  const changed = db
    .prepare(
      `UPDATE receipts
          SET status = ?, tx_hash = ?, detail = ?, settled_at = ?
        WHERE id = ? AND status = 'awaiting'`,
    )
    .run(status, fields.txHash ?? null, fields.detail ?? null, settledAt, id);
  if (Number(changed.changes) === 0) {
    // Not thrown: the request that lost this race has nothing useful to do
    // about it, and the row is already in a terminal state either way. Loud
    // enough to notice if it becomes common.
    console.warn(`[receipts] ${id} was already resolved; ignoring a late ${status}`);
  }
}

/**
 * The states a receipt can be reconciled OUT of, once the chain has been asked.
 *
 * Both mean "not settled, and Fuel is not certain that is the last word."
 * `settle_unknown` never had an answer; `served_unsettled` has the
 * facilitator's answer, which is a report rather than the ledger itself and can
 * be wrong in the direction that matters (a settlement that landed after the
 * response failed). Neither is in APPEARS_IN_RECEIPT_LEDGER, so reconciling one
 * can only ever ADD revenue that genuinely arrived.
 */
const RECONCILABLE = "('settle_unknown', 'served_unsettled')";

/**
 * Records what the chain said about a receipt whose outcome was never
 * confirmed.
 *
 * A SEPARATE FUNCTION FROM `resolveReceipt`, AND THAT IS THE POINT. The
 * tempting change is to widen `resolveReceipt`'s `WHERE status = 'awaiting'`
 * guard to accept these states too. That guard is what makes the claim→resolve
 * race safe: it stops a late-returning request overwriting a row the reaper
 * already resolved. Widening it would reopen that race to fix an unrelated
 * problem, and every existing test would still pass, because the race needs
 * concurrency to show. So the guards stay disjoint — `resolveReceipt` owns the
 * live request path and only ever moves `awaiting`; this owns the reconcile
 * path and only ever moves the two states that path is for.
 *
 * `detail` is required rather than optional. A row that changed state after the
 * fact, on evidence gathered separately from the request that created it,
 * should never be indistinguishable from one that resolved normally.
 *
 * Returns false when nothing changed — the row was already reconciled, or it
 * was never in a reconcilable state. The caller decides whether that is a 409.
 */
export function reconcileReceipt(
  id: string,
  outcome: "settled" | "served_unsettled",
  fields: { txHash?: string | null; detail: string },
): boolean {
  const settledAt = outcome === "settled" ? new Date().toISOString() : null;
  const changed = db
    .prepare(
      `UPDATE receipts
          SET status = ?, tx_hash = ?, detail = ?, settled_at = ?
        WHERE id = ? AND status IN ${RECONCILABLE}`,
    )
    .run(outcome, fields.txHash ?? null, fields.detail, settledAt, id);
  return Number(changed.changes) > 0;
}

/**
 * Receipts whose outcome Fuel could not establish, oldest first.
 *
 * The inbound counterpart of `pendingPostings()`, and it exists for the same
 * reason: an operator cannot act on a state they have to know to go looking
 * for. These are the rows where money may have arrived and is not in anyone's
 * books, or where a customer's origin did work that was never paid for.
 */
export function receiptsNeedingAttention(companyId: string): Receipt[] {
  const rows = db
    .prepare(
      `SELECT r.* FROM receipts r
       JOIN agents a ON a.id = r.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE t.company_id = ? AND r.status IN ${RECONCILABLE}
       ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(companyId) as unknown as ReceiptRow[];
  return rows.map(toReceipt);
}

/**
 * Resolves receipts stranded mid-request by a crash.
 *
 * The same shape as `reapStaleReservations` on the outbound side, and it exists
 * for the same reason: the row is claimed before the work happens, so a process
 * that dies in between leaves one behind. Here it matters more than it looks,
 * because the UNIQUE constraint means a stranded row permanently burns that
 * payer's authorization nonce — without this, a crash silently costs a payer
 * the ability to ever use that signature.
 *
 * Resolved to `settle_unknown`, not `abandoned`. A crash could have happened
 * either side of the settle call, so "we do not know" is the honest answer, and
 * it is the one that keeps the amount out of the books.
 */
export function reapStaleAwaitingReceipts(olderThanMs: number): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = db
    .prepare(
      `UPDATE receipts
          SET status = 'settle_unknown',
              detail = 'abandoned mid-request; settlement outcome never observed'
        WHERE status = 'awaiting' AND created_at < ?`,
    )
    .run(cutoff);
  return Number(result.changes);
}

/* -------------------------------------------------------------------------
 * What was actually earned.
 *
 * Only `settled`, because APPEARS_IN_RECEIPT_LEDGER is the set, and the
 * asymmetry with the spend side is deliberate rather than an oversight: spend
 * includes `unreconciled` (money that may have moved, and omitting a real
 * exposure would understate what is owed), while earn excludes both unresolved
 * states, because recording either as revenue would OVERSTATE what a customer
 * earned. Fail-closed in opposite directions, exactly as the header of this
 * file argues.
 *
 * So a P&L's earned figure is the conservative one and its spent figure is the
 * cautious one, and the net between them leans the safe way in both terms.
 * ---------------------------------------------------------------------- */

/** What this agent's endpoints actually took in. */
export function earnedBaseUnits(agentId: string): bigint {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM receipts
       WHERE agent_id = ? AND status IN ${APPEARS_IN_RECEIPT_LEDGER}`,
    )
    .get(agentId) as { total: number | bigint };
  return BigInt(row.total);
}

/** The same, for a whole company, through the same agents -> teams seam. */
export function companyEarnedBaseUnits(companyId: string): bigint {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(r.amount_base_units), 0) AS total
       FROM receipts r
       JOIN agents a ON a.id = r.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE t.company_id = ? AND r.status IN ${APPEARS_IN_RECEIPT_LEDGER}`,
    )
    .get(companyId) as { total: number | bigint };
  return BigInt(row.total);
}

/**
 * What each endpoint has taken in, keyed by endpoint id.
 *
 * ONE GROUPED QUERY RATHER THAN A SUM PER ENDPOINT. The list route renders
 * every endpoint a company has, and a per-endpoint call would make the cost of
 * that page grow with the number of endpoints — the same N+1 the Activity
 * Ledger avoids by fetching approvals for a page rather than joining them.
 *
 * Receipts with a NULL endpoint_id are omitted rather than gathered under a
 * placeholder key. They exist — an endpoint can be deleted out from under a
 * settled receipt — and db/postings.ts already books them under
 * UNATTRIBUTED_COUNTERPARTY so the money is never lost to the accounts. But
 * this map answers "what did THIS endpoint earn", and there is no endpoint to
 * answer for.
 *
 * An endpoint that has earned nothing is ABSENT from the map, not present with
 * a zero. A caller that defaults a missing key to 0n gets the right answer; one
 * that iterates the map gets only endpoints with real revenue.
 */
export function earnedByEndpoint(companyId: string): Map<string, bigint> {
  const rows = db
    .prepare(
      `SELECT r.endpoint_id AS endpoint_id,
              COALESCE(SUM(r.amount_base_units), 0) AS total
       FROM receipts r
       JOIN agents a ON a.id = r.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE t.company_id = ?
         AND r.endpoint_id IS NOT NULL
         AND r.status IN ${APPEARS_IN_RECEIPT_LEDGER}
       GROUP BY r.endpoint_id`,
    )
    .all(companyId) as unknown as { endpoint_id: string; total: number | bigint }[];
  return new Map(rows.map((row) => [row.endpoint_id, BigInt(row.total)]));
}

/**
 * How many receipts each endpoint is still waiting on an answer for.
 *
 * The same grouped shape, over the two states nothing could resolve. An
 * endpoint that served work and was not paid is the one fact the Earning page
 * must not be able to hide, and a count beside the revenue figure is what stops
 * a healthy-looking total standing in for it.
 */
export function stuckCountByEndpoint(companyId: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT r.endpoint_id AS endpoint_id, COUNT(*) AS n
       FROM receipts r
       JOIN agents a ON a.id = r.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE t.company_id = ?
         AND r.endpoint_id IS NOT NULL
         AND r.status IN ${RECONCILABLE}
       GROUP BY r.endpoint_id`,
    )
    .all(companyId) as unknown as { endpoint_id: string; n: number }[];
  return new Map(rows.map((row) => [row.endpoint_id, Number(row.n)]));
}

/**
 * Every receipt for one company, oldest first.
 *
 * Scoped through `agents -> teams -> company_id`, the same join path every
 * other company-scoped read uses. Per ADR 0009 that predicate is a query seam
 * and not tenant isolation, and nothing here changes that.
 */
export function listReceiptsForCompany(companyId: string): Receipt[] {
  const rows = db
    .prepare(
      `SELECT r.* FROM receipts r
       JOIN agents a ON a.id = r.agent_id
       JOIN teams  t ON t.id = a.team_id
       WHERE t.company_id = ?
       ORDER BY r.created_at ASC, r.id ASC`,
    )
    .all(companyId) as unknown as ReceiptRow[];
  return rows.map(toReceipt);
}
