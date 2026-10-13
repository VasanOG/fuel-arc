/**
 * The Activity Ledger: both directions of money, one page, one cursor.
 *
 * WHY THIS IS NOT IN payments.ts. That file's entire argument is that a receipt
 * is not a payment and cannot reach a cap query — `COUNTS_AGAINST_CAP` is
 * interpolated into the cap sums, and a receipts table that could be reached
 * from there is a table that could raise what an agent may spend. A UNION built
 * inside payments.ts would put both tables within one import of those sums.
 * Here, the merged read is what it actually is: a display concern that reads
 * two tables and writes to neither.
 *
 * THE UNION CARRIES THE SORT KEY AND NOTHING ELSE, and that is the whole shape
 * of this file. `computeBuckets` in db/postings.ts already rejected a UNION for
 * the accounting path, and its reason applies here word for word: spend and
 * revenue do not share their sources, their eligible-status sets, or what
 * identifies their counterparty, so a wide UNION "would have to flatten all
 * three into columns that mean different things per row." A compound SELECT
 * matches its arms BY POSITION, so that flattening is one misplaced column away
 * from mapping `settled_at` onto `detail` silently.
 *
 * So the compound select projects exactly three columns — a direction tag, an
 * id, and a timestamp — which mean the same thing on both sides and are short
 * enough to verify by eye. That page of keys then drives two ordinary
 * per-table reads, the same two-passes-over-two-tables discipline postings.ts
 * uses, and neither direction can inherit the other's rules by accident.
 *
 * See docs/decisions/0011-the-earning-side.md.
 */
import { UNATTRIBUTED_COUNTERPARTY } from "./earning-endpoints.js";
import { db } from "./index.js";
import {
  PAYMENT_STATUSES,
  toPayment,
  type Payment,
  type PaymentRow,
  type PaymentStatus,
} from "./payments.js";
import { RECEIPT_STATUSES, type ReceiptStatus } from "./receipts.js";

export type LedgerDirection = "spend" | "earn";
export type LedgerOrder = "newest" | "oldest";

export interface LedgerCursor {
  createdAt: string;
  id: string;
}

/**
 * Money leaving. Still the full `Payment` shape, deliberately.
 *
 * The earn row below is narrower than its table; this one is not, and the
 * asymmetry is honest rather than sloppy. `presentActivityPayment` derives the
 * vendor from `resourceUrl` and the refusal label from `refusalCode`, so those
 * columns have to arrive here to be turned into the two fields that do reach a
 * browser. `txHash` and `detail` ride along because they are on `Payment`, and
 * the API's field-by-field pick is what keeps them off the wire — a boundary
 * that verify-api asserts on delivered bytes, not on a type.
 */
export interface LedgerSpendRow extends Payment {
  direction: "spend";
  agentName: string;
  teamId: string;
  teamName: string;
  /** Display only: when the money moved, falling back to when it was
   *  reserved. Never sorted or paginated on — see `listLedgerPage`. */
  ledgerDate: string;
  approval: { id: string; blockedScope: string; decidedAt: string | null } | null;
}

/**
 * Money arriving. Born narrow, on purpose.
 *
 * `payer_address`, `authorization_nonce`, `tx_hash` and `detail` are not absent
 * from this shape because a later layer strips them — they are never selected,
 * so no object in this process ever holds them on a ledger row. The API's
 * allowlist still stands in front of this (a boundary that exists only in one
 * place is a boundary one refactor from being gone), but a new field cannot
 * reach the wire by being spread from a row that was never loaded.
 *
 * That was affordable here and not on the spend side because this row is new.
 * Nothing downstream needs a receipt's chain identifiers to render a ledger
 * line, so nothing loads them.
 */
export interface LedgerEarnRow {
  direction: "earn";
  id: string;
  agentId: string;
  agentName: string;
  teamId: string;
  teamName: string;
  endpointId: string | null;
  /**
   * What the books call the endpoint that earned this.
   *
   * The counterparty of an inbound line is NOT the payer — it is the endpoint
   * that did the work, exactly as db/postings.ts keys revenue buckets. The
   * payer is a third party who never agreed to appear in anyone's dashboard,
   * and naming them here would reintroduce the address 0006 keeps out.
   */
  counterparty: string;
  amountBaseUnits: bigint;
  status: ReceiptStatus;
  createdAt: string;
  settledAt: string | null;
  ledgerDate: string;
}

export type LedgerRow = LedgerSpendRow | LedgerEarnRow;

export interface LedgerPageOptions {
  /**
   * REQUIRED. Every arm is constrained to one company through
   * (payments|receipts) -> agents -> teams.
   *
   * The same standing caveat the whole codebase carries: this is a QUERY SEAM,
   * not tenant isolation. src/lib/auth.ts resolves a role and never a tenant,
   * so this predicate cannot stop a credential holder from reading another
   * company's data — there is no second company and no way to tell two
   * operators apart. What it buys is that the day a second company exists,
   * neither direction silently widens.
   */
  companyId: string;
  limit: number;
  order: LedgerOrder;
  cursor?: LedgerCursor;
  /** Empty or absent means both. */
  directions?: LedgerDirection[];
  agentIds?: string[];
  teamIds?: string[];
  /**
   * Status names from EITHER vocabulary, already validated as known.
   *
   * Passed unsplit and divided here rather than by the caller, because the rule
   * for what an unmatched half means is the subtle part, and the two
   * vocabularies are not cleanly separable by inspection — they share `settled`.
   * Keeping the split in one function keeps it in one place.
   */
  statuses?: string[];
  /** Inclusive whole UTC days, applied to created_at — the sort key, so a
   *  page's range always matches its ordering. */
  from?: string;
  to?: string;
  demo?: boolean;
}

/** Ordering columns are literals from this file; only values are ever bound. */
type SqlParam = string | number;

/**
 * The predicates both directions share.
 *
 * `alias` is a literal written in this file — "p" or "r" — never caller text.
 * Every dynamic fragment below is built from the COUNT of already-validated
 * values, never from the values themselves.
 */
function commonPredicates(
  alias: string,
  opts: LedgerPageOptions,
): { where: string[]; params: SqlParam[] } {
  const where: string[] = ["t.company_id = ?"];
  const params: SqlParam[] = [opts.companyId];

  if (opts.agentIds && opts.agentIds.length > 0) {
    where.push(`${alias}.agent_id IN (${opts.agentIds.map(() => "?").join(", ")})`);
    params.push(...opts.agentIds);
  }
  if (opts.teamIds && opts.teamIds.length > 0) {
    where.push(`t.id IN (${opts.teamIds.map(() => "?").join(", ")})`);
    params.push(...opts.teamIds);
  }
  if (opts.from) {
    where.push(`${alias}.created_at >= ?`);
    params.push(opts.from);
  }
  if (opts.to) {
    where.push(`${alias}.created_at <= ?`);
    params.push(`${opts.to}T23:59:59.999Z`);
  }
  if (opts.cursor) {
    // Applied per arm rather than to the compound result: it is a predicate on
    // rows, and an arm that skipped it would contribute rows the cursor has
    // already passed, which is exactly the duplicate an OFFSET pager produces.
    const compare = opts.order === "newest" ? "<" : ">";
    where.push(
      `(${alias}.created_at ${compare} ? OR (${alias}.created_at = ? AND ${alias}.id ${compare} ?))`,
    );
    params.push(opts.cursor.createdAt, opts.cursor.createdAt, opts.cursor.id);
  }

  return { where, params };
}

/**
 * One page of the ledger, newest or oldest first, across both directions.
 *
 * KEYSET, NOT OFFSET, and the sort key is (created_at, id) — both immutable,
 * on both tables. Three things follow, and all three are load-bearing:
 *
 * OFFSET is wrong because rows arrive at the head. Between two requests a new
 * payment OR a new receipt shifts every later row by one, so a caller paging
 * with OFFSET silently re-reads one row and silently skips another. Merging two
 * tables makes that strictly worse, since either table can do the shifting.
 *
 * `settled_at` is wrong as a sort key for a subtler reason. Both directions
 * date a ledger line by COALESCE(settled_at, created_at), which is right for an
 * accounting file, but that expression MUTATES: a pending row settles and its
 * ledger date jumps. A row that moves after a cursor has passed it is a row the
 * caller never sees. So `ledgerDate` is returned for display and never ordered
 * on.
 *
 * (created_at, id) REMAINS A TOTAL ORDER ACROSS THE MERGE, which is what makes
 * one cursor legal over two tables. created_at is a fixed-width UTC
 * toISOString() with three fractional digits and is never client-supplied, so
 * lexicographic comparison is exact — the property velocity.ts and
 * listPaymentsForExport already rely on. `id` is a UUID from randomUUID() in
 * both tables, so a payment and a receipt written in the same millisecond still
 * break the tie, and they break it the same way on every page.
 */
export function listLedgerPage(opts: LedgerPageOptions): {
  rows: LedgerRow[];
  hasMore: boolean;
} {
  const directions = opts.directions ?? [];
  const wantSpend = directions.length === 0 || directions.includes("spend");
  const wantEarn = directions.length === 0 || directions.includes("earn");

  /*
   * THE TWO STATUS VOCABULARIES OVERLAP ON EXACTLY ONE WORD, and getting that
   * exactly right is what decides whether a status filter lies.
   *
   * `PaymentStatus` and `ReceiptStatus` share `settled` and nothing else.
   * receipts.ts reasoned its set from the inbound direction rather than
   * mirroring the outbound one, so there is no `blocked` inbound and no
   * `served_unsettled` outbound — but both directions do settle, and there the
   * word means the same event on both sides.
   *
   * So the list is split by MEMBERSHIP rather than partitioned: `settled` lands
   * in both halves and constrains both arms, which is right, because an
   * operator asking for settled rows means settled rows in whichever directions
   * are in scope. A word belonging to one vocabulary lands in one half, and the
   * other arm's half comes back empty.
   *
   * AN EMPTY HALF DROPS THAT ARM ENTIRELY. A filter naming only outbound
   * statuses describes a question the earn side has no rows for, and the honest
   * answer is none of them, not all of them. The alternative — leaving the arm
   * unfiltered because its half was empty — would return every receipt ever
   * written in response to `?status=blocked`, which is the failure mode this
   * split exists to prevent.
   */
  const statuses = opts.statuses ?? [];
  const statusFiltered = statuses.length > 0;
  const paymentStatuses = statuses.filter((s) =>
    (PAYMENT_STATUSES as string[]).includes(s),
  ) as PaymentStatus[];
  const receiptStatuses = statuses.filter((s) =>
    (RECEIPT_STATUSES as string[]).includes(s),
  ) as ReceiptStatus[];

  /*
   * `demo=true` EXCLUDES THE EARN SIDE ENTIRELY, and this is the asymmetry most
   * likely to be "fixed" by someone who has not read this.
   *
   * `payments.is_demo` exists and `receipts` has no such column, because no
   * path anywhere writes a demo receipt — scripts/seed-demo-day.ts marks
   * payments and approval_requests, and nothing else may set the flag at all.
   * So demo rows are a strict subset of the spend side.
   *
   * demo=true therefore means "only seeded rows", and every receipt is real:
   * returning receipts anyway would present genuine revenue inside a view whose
   * entire purpose is to isolate fabricated data. demo=false means "only real
   * rows", which every receipt is, so the earn arm is included whole. Treating
   * the missing column as "unknown, include either way" would be the same class
   * of mistake as an "Unknown" label standing in for a real answer.
   */
  const includeSpend = wantSpend && (!statusFiltered || paymentStatuses.length > 0);
  const includeEarn =
    wantEarn && (!statusFiltered || receiptStatuses.length > 0) && opts.demo !== true;

  const armSql: string[] = [];
  const armParams: SqlParam[] = [];

  if (includeSpend) {
    const { where, params } = commonPredicates("p", opts);
    if (paymentStatuses.length > 0) {
      where.push(`p.status IN (${paymentStatuses.map(() => "?").join(", ")})`);
      params.push(...paymentStatuses);
    }
    if (opts.demo !== undefined) {
      where.push("p.is_demo = ?");
      params.push(opts.demo ? 1 : 0);
    }
    armSql.push(
      `SELECT 'spend' AS direction, p.id AS id, p.created_at AS created_at
         FROM payments p
         JOIN agents a ON a.id = p.agent_id
         JOIN teams  t ON t.id = a.team_id
        WHERE ${where.join(" AND ")}`,
    );
    armParams.push(...params);
  }

  if (includeEarn) {
    const { where, params } = commonPredicates("r", opts);
    if (receiptStatuses.length > 0) {
      where.push(`r.status IN (${receiptStatuses.map(() => "?").join(", ")})`);
      params.push(...receiptStatuses);
    }
    armSql.push(
      `SELECT 'earn' AS direction, r.id AS id, r.created_at AS created_at
         FROM receipts r
         JOIN agents a ON a.id = r.agent_id
         JOIN teams  t ON t.id = a.team_id
        WHERE ${where.join(" AND ")}`,
    );
    armParams.push(...params);
  }

  // Both arms dropped — a direction filter and a status filter that cannot both
  // be satisfied. An empty page is the answer; querying `WHERE 0` to produce it
  // would be the same answer with a scan attached.
  if (armSql.length === 0) return { rows: [], hasMore: false };

  const sort = opts.order === "newest" ? "DESC" : "ASC";

  /*
   * One extra key decides hasMore and is then discarded, so the answer costs
   * nothing beyond the page itself. A COUNT(*) would be a second scan at a
   * different instant, and a total that disagrees with the pages is worse than
   * no total — doubly so here, where it would be two scans over two tables.
   */
  const keys = db
    .prepare(
      `SELECT direction, id, created_at
         FROM (${armSql.join("\n        UNION ALL\n")})
        ORDER BY created_at ${sort}, id ${sort}
        LIMIT ?`,
    )
    .all(...([...armParams, opts.limit + 1] as never[])) as unknown as {
    direction: LedgerDirection;
    id: string;
    created_at: string;
  }[];

  const hasMore = keys.length > opts.limit;
  const page = hasMore ? keys.slice(0, opts.limit) : keys;
  if (page.length === 0) return { rows: [], hasMore: false };

  const spendIds = page.filter((k) => k.direction === "spend").map((k) => k.id);
  const earnIds = page.filter((k) => k.direction === "earn").map((k) => k.id);

  const spend = spendIds.length > 0 ? loadSpendRows(spendIds, opts.companyId) : new Map();
  const earn = earnIds.length > 0 ? loadEarnRows(earnIds, opts.companyId) : new Map();

  /*
   * Reassembled in key order, and keyed per direction rather than by id alone.
   *
   * Two UUID namespaces collide with probability nobody will ever observe, but
   * one map keyed by bare id would make that collision silently return the
   * wrong row rather than fail, and "impossible" is not a property worth
   * spending on an unnecessary risk.
   *
   * A key whose row vanished between the two queries is dropped rather than
   * rendered as a hole. Nothing deletes payments or receipts today, so this is
   * defensive; a short page is honest, a null row is not.
   */
  const rows: LedgerRow[] = [];
  for (const key of page) {
    const row = key.direction === "spend" ? spend.get(key.id) : earn.get(key.id);
    if (row) rows.push(row);
  }

  return { rows, hasMore };
}

/** The spend half of a page, by id, company-scoped again on the way in. */
function loadSpendRows(ids: string[], companyId: string): Map<string, LedgerSpendRow> {
  const placeholders = ids.map(() => "?").join(", ");

  // Re-scoped rather than trusted: the ids came from a company-scoped query, so
  // this predicate drops nothing today. It is here so that a future caller that
  // passes ids from somewhere else cannot turn this into an unscoped read.
  const found = db
    .prepare(
      `SELECT p.*, a.name AS agent_name, t.id AS team_id, t.name AS team_name,
              COALESCE(p.settled_at, p.created_at) AS ledger_date
         FROM payments p
         JOIN agents a ON a.id = p.agent_id
         JOIN teams  t ON t.id = a.team_id
        WHERE p.id IN (${placeholders}) AND t.company_id = ?`,
    )
    .all(...([...ids, companyId] as never[])) as unknown as (PaymentRow & {
    agent_name: string;
    team_id: string;
    team_name: string;
    ledger_date: string;
  })[];

  /*
   * Approvals are fetched for the page rather than LEFT JOINed.
   *
   * Nothing in the schema stops two approval rows pointing at one payment, and
   * a join that returned two rows for one payment would break the page size,
   * the cursor and hasMore all at once. A bounded second query cannot.
   */
  const approvals = new Map<
    string,
    { id: string; blockedScope: string; decidedAt: string | null }
  >();
  const approvalRows = db
    .prepare(
      `SELECT id, payment_id, blocked_scope, decided_at
         FROM approval_requests
        WHERE payment_id IN (${placeholders})`,
    )
    .all(...(ids as never[])) as unknown as {
    id: string;
    payment_id: string;
    blocked_scope: string;
    decided_at: string | null;
  }[];
  for (const row of approvalRows) {
    if (!approvals.has(row.payment_id)) {
      approvals.set(row.payment_id, {
        id: row.id,
        blockedScope: row.blocked_scope,
        decidedAt: row.decided_at,
      });
    }
  }

  const out = new Map<string, LedgerSpendRow>();
  for (const row of found) {
    out.set(row.id, {
      direction: "spend",
      ...toPayment(row),
      agentName: row.agent_name,
      teamId: row.team_id,
      teamName: row.team_name,
      ledgerDate: row.ledger_date,
      approval: approvals.get(row.id) ?? null,
    });
  }
  return out;
}

/** The earn half of a page, by id, selecting only what a ledger line renders. */
function loadEarnRows(ids: string[], companyId: string): Map<string, LedgerEarnRow> {
  const placeholders = ids.map(() => "?").join(", ");

  // An explicit column list, not `r.*`. The redaction that matters most on this
  // side is the one that never loads the column: payer_address,
  // authorization_nonce, tx_hash and detail are absent from this SELECT, so a
  // future spread cannot carry them and a future migration cannot add a fifth.
  const found = db
    .prepare(
      `SELECT r.id AS id, r.agent_id AS agent_id, r.endpoint_id AS endpoint_id,
              r.amount_base_units AS amount_base_units, r.status AS status,
              r.created_at AS created_at, r.settled_at AS settled_at,
              COALESCE(r.settled_at, r.created_at) AS ledger_date,
              a.name AS agent_name, t.id AS team_id, t.name AS team_name,
              ee.label AS endpoint_label
         FROM receipts r
         JOIN agents a ON a.id = r.agent_id
         JOIN teams  t ON t.id = a.team_id
         LEFT JOIN earning_endpoints ee ON ee.id = r.endpoint_id
        WHERE r.id IN (${placeholders}) AND t.company_id = ?`,
    )
    .all(...([...ids, companyId] as never[])) as unknown as {
    id: string;
    agent_id: string;
    endpoint_id: string | null;
    amount_base_units: number | bigint;
    status: string;
    created_at: string;
    settled_at: string | null;
    ledger_date: string;
    agent_name: string;
    team_id: string;
    team_name: string;
    endpoint_label: string | null;
  }[];

  const out = new Map<string, LedgerEarnRow>();
  for (const row of found) {
    out.set(row.id, {
      direction: "earn",
      id: row.id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      teamId: row.team_id,
      teamName: row.team_name,
      endpointId: row.endpoint_id,
      // The same fallback db/postings.ts uses for a revenue bucket, so one
      // receipt reads the same in the ledger and in the books.
      counterparty: row.endpoint_label ?? UNATTRIBUTED_COUNTERPARTY,
      amountBaseUnits: BigInt(row.amount_base_units),
      status: row.status as ReceiptStatus,
      createdAt: row.created_at,
      settledAt: row.settled_at,
      ledgerDate: row.ledger_date,
    });
  }
  return out;
}
