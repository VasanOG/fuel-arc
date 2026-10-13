/**
 * The accounting rollup engine: turning sub-cent payments into postable lines.
 *
 * src/accounting/rollup.ts holds the arithmetic, pure and testable. This file
 * is what talks to the database: it reads what is owed, reads what has already
 * been posted, and writes the difference out as lines once it crosses a cent.
 *
 * THE ONE IDEA TO KEEP HOLD OF: there is no stored residual anywhere. The
 * amount still waiting to clear is always computed as
 *
 *     residual = owed (from payments) - posted (from export_postings)
 *
 * A mutable per-bucket counter is the obvious implementation and it is the
 * wrong one. This codebase already made the same call once, in spentBaseUnits:
 * "derived from the payments table rather than kept as a running total on the
 * agent, so it cannot drift out of sync with what actually happened." The
 * stakes are higher here, because these numbers become entries in someone's
 * real books. Deriving buys three things:
 *
 *   1. The residual cannot drift. It is recomputed from immutable facts.
 *   2. A crashed run cannot lose or duplicate money. A counter decremented
 *      without its line written deletes money from the books; a line written
 *      without the counter moving posts it twice.
 *   3. Reclassification needs no machinery at all — see runPosting below.
 *
 * Nothing in this file moves money, signs anything, or reaches Fireblocks. It
 * reads `payments` and writes only `posting_lines` and `export_postings`.
 */

import { randomUUID } from "node:crypto";
import {
  CENT_BASE_UNITS,
  EARN_CLASSES,
  SPEND_CLASSES,
  clearable,
  ledgerClassFor,
  planAbsorption,
  postingDayFor,
  sourceKindFor,
  type AbsorptionCandidate,
  type LedgerClass,
  type SpendClass,
} from "../accounting/rollup.js";
import { vendorFromResourceUrl } from "../lib/export-presentation.js";
import { APPEARS_IN_LEDGER, type PaymentStatus } from "./payments.js";
import { APPEARS_IN_RECEIPT_LEDGER, type ReceiptStatus } from "./receipts.js";
import { UNATTRIBUTED_COUNTERPARTY } from "./earning-endpoints.js";
import { db } from "./index.js";

/**
 * A bucket is the unit that accumulates: one agent, one counterparty, one
 * account.
 *
 * "Counterparty" rather than "vendor" because the other party is a vendor only
 * on the spend side. For revenue it is one of the agent's own earning
 * endpoints, named by its label. 0012.
 */
export interface Bucket {
  agentId: string;
  agentName: string;
  counterparty: string;
  ledgerClass: LedgerClass;
  /** owed - posted. Negative means this bucket has posted more than it now owes. */
  residual: bigint;
  /** The sources with unabsorbed money in this bucket, oldest first. */
  candidates: AbsorptionCandidate[];
}

interface LedgerPaymentRow {
  id: string;
  agent_id: string;
  agent_name: string;
  resource_url: string;
  status: PaymentStatus;
  amount_base_units: number | bigint;
  ledger_date: string;
  absorbed_expense: number | bigint;
  absorbed_suspense: number | bigint;
}

/**
 * Every payment that either belongs in the books now or has been posted before.
 *
 * The second half of that `WHERE` is what makes reclassification work, and it
 * is easy to leave out. A payment that was `unreconciled` when it was posted
 * into suspense and has since settled is no longer owed to suspense at all —
 * but suspense has already posted it, and that has to be undone. Filtering on
 * current status alone would make such a payment invisible to the very bucket
 * that needs correcting, and the suspense account would hold the amount
 * forever.
 *
 * Ordered oldest-first on the same LEDGER_DATE expression the CSV export
 * filters and sorts by, so absorption is FIFO and both surfaces agree on when
 * a payment happened.
 */
function readLedgerPayments(companyId: string): LedgerPaymentRow[] {
  const LEDGER_DATE = "COALESCE(p.settled_at, p.created_at)";

  return db
    .prepare(
      `SELECT p.id,
              p.agent_id,
              a.name                 AS agent_name,
              p.resource_url,
              p.status,
              p.amount_base_units,
              ${LEDGER_DATE}         AS ledger_date,
              COALESCE(e.absorbed, 0) AS absorbed_expense,
              COALESCE(s.absorbed, 0) AS absorbed_suspense
       FROM payments p
       JOIN agents a ON a.id = p.agent_id
       -- The company seam, the same agents -> teams path every other scoped
       -- read in this codebase uses. Both hops are NOT NULL, so it drops no
       -- row that belongs to this company.
       JOIN teams  t ON t.id = a.team_id
       -- The IS NOT NULL is redundant twice over: the class filter already
       -- excludes revenue lines, and a NULL group could never match p.id
       -- anyway. Stated because a reader should not have to derive that, and
       -- because the next person to widen this query is the one who would
       -- remove the class filter without noticing it was load-bearing.
       LEFT JOIN (
         SELECT ep.payment_id, SUM(ep.absorbed_base_units) AS absorbed
         FROM export_postings ep
         JOIN posting_lines pl ON pl.id = ep.line_id
         WHERE pl.ledger_class = 'expense' AND ep.payment_id IS NOT NULL
         GROUP BY ep.payment_id
       ) e ON e.payment_id = p.id
       LEFT JOIN (
         SELECT ep.payment_id, SUM(ep.absorbed_base_units) AS absorbed
         FROM export_postings ep
         JOIN posting_lines pl ON pl.id = ep.line_id
         WHERE pl.ledger_class = 'suspense' AND ep.payment_id IS NOT NULL
         GROUP BY ep.payment_id
       ) s ON s.payment_id = p.id
       -- THE PARENTHESES ARE LOAD-BEARING. The eligibility test is a chain of
       -- ORs, so an appended \`AND t.company_id = ?\` would bind to the last
       -- disjunct alone and this query would return every company's settled
       -- payments plus one company's absorbed ones. Scope first, then the
       -- bracketed test -- the same ordering listPaymentsForExport uses, and
       -- for the same reason: the predicate must be present in every query
       -- this function can build rather than depending on a branch.
       WHERE t.company_id = ?
         AND (p.status IN ${APPEARS_IN_LEDGER}
              OR e.absorbed IS NOT NULL
              OR s.absorbed IS NOT NULL)
       ORDER BY ${LEDGER_DATE} ASC, p.id ASC`,
    )
    .all(companyId) as unknown as LedgerPaymentRow[];
}

interface LedgerReceiptRow {
  id: string;
  agent_id: string;
  agent_name: string;
  endpoint_id: string | null;
  counterparty: string | null;
  status: ReceiptStatus;
  amount_base_units: number | bigint;
  ledger_date: string;
  absorbed_revenue: number | bigint;
}

/**
 * The receipt analogue of readLedgerPayments: money Fuel witnessed ARRIVING.
 *
 * The same two-part WHERE, for the same reason. A receipt that is no longer
 * ledger-eligible but has already been posted still has to be visible, or the
 * revenue account would hold an amount forever with nothing able to correct it.
 * Today no receipt can leave `settled` — resolveReceipt guards on `awaiting`,
 * so every terminal status is frozen — but the clause is not written on the
 * strength of that. It is written so the arithmetic stays right if the
 * vocabulary ever grows a reversal, which is exactly the change that would
 * otherwise strand money.
 *
 * The endpoint LEFT JOIN is deliberate rather than an inner one: endpoint_id is
 * nullable, and an inner join would silently drop an unattributable receipt
 * from the ledger entirely — money arriving and simply not appearing. That is
 * the failure shape 0012 spent a section on. It comes back as a NULL
 * counterparty instead, which computeBuckets names and verifyPostingIntegrity
 * reports.
 */
function readLedgerReceipts(companyId: string): LedgerReceiptRow[] {
  const LEDGER_DATE = "COALESCE(r.settled_at, r.created_at)";

  return db
    .prepare(
      `SELECT r.id,
              r.agent_id,
              a.name                 AS agent_name,
              r.endpoint_id,
              ee.label               AS counterparty,
              r.status,
              r.amount_base_units,
              ${LEDGER_DATE}         AS ledger_date,
              COALESCE(v.absorbed, 0) AS absorbed_revenue
       FROM receipts r
       JOIN agents a ON a.id = r.agent_id
       -- The same seam as the spend side above, for the same reason.
       JOIN teams  t ON t.id = a.team_id
       LEFT JOIN earning_endpoints ee ON ee.id = r.endpoint_id
       LEFT JOIN (
         SELECT ep.receipt_id, SUM(ep.absorbed_base_units) AS absorbed
         FROM export_postings ep
         JOIN posting_lines pl ON pl.id = ep.line_id
         WHERE pl.ledger_class = 'revenue' AND ep.receipt_id IS NOT NULL
         GROUP BY ep.receipt_id
       ) v ON v.receipt_id = r.id
       -- Bracketed for the reason the spend side spells out above.
       WHERE t.company_id = ?
         AND (r.status IN ${APPEARS_IN_RECEIPT_LEDGER}
              OR v.absorbed IS NOT NULL)
       ORDER BY ${LEDGER_DATE} ASC, r.id ASC`,
    )
    .all(companyId) as unknown as LedgerReceiptRow[];
}

/**
 * What every bucket currently owes the books, and out of which sources.
 *
 * For each source and each class, the amount still to absorb is
 *
 *     available = owed - already absorbed
 *
 * where `owed` is the source's full amount if it currently belongs to that
 * class and zero otherwise. A source that has left a class therefore shows a
 * NEGATIVE available there, which is exactly the correction that needs posting.
 * Buckets with nothing outstanding are dropped.
 *
 * TWO PASSES OVER TWO TABLES, NOT ONE PASS OVER A UNION. Spend and revenue
 * share this arithmetic but not their sources, their eligible-status sets, or
 * what identifies their counterparty, and a UNION would have to flatten all
 * three into columns that mean different things per row. Two passes cost a
 * repeated shape and buy the property that neither direction can quietly
 * inherit the other's rules — which is the same argument 0012 makes for
 * splitting conservation into two equations rather than summing one.
 *
 * COMPANY-SCOPED, AND REQUIRED. Until 7A-1 this function took no companyId and
 * swept every company's payments and receipts into one bucket set — which
 * `GET /api/postings` then emitted verbatim, agent names and counterparty hosts
 * included, to any operator. ADR 0009 documented the company predicate as "a
 * seam, not tenant isolation" and named the two reads that lacked it; it did
 * not name this engine, and this engine never had the predicate at all.
 *
 * The parameter is required and non-defaultable. A default would reintroduce
 * exactly the bug it was added to close, silently, on the first caller that
 * omitted it.
 */
export function computeBuckets(companyId: string): Bucket[] {
  const buckets = new Map<string, Bucket>();

  /**
   * JSON rather than a delimiter string, and deliberately not the NUL separator
   * this first used: vendorFromResourceUrl falls back to the raw resource URL
   * when it will not parse, so a "host" can in principle be arbitrary text
   * containing whatever separator was picked. JSON cannot collide, and unlike a
   * control character it leaves this file as text that git will diff rather
   * than treat as binary.
   */
  const keyOf = (agentId: string, bucketKey: string, ledgerClass: LedgerClass): string =>
    JSON.stringify([agentId, bucketKey, ledgerClass]);

  const accumulate = (params: {
    key: string;
    agentId: string;
    agentName: string;
    counterparty: string;
    ledgerClass: LedgerClass;
    available: bigint;
    sourceId: string;
    ledgerDay: string;
  }): void => {
    let bucket = buckets.get(params.key);
    if (bucket === undefined) {
      bucket = {
        agentId: params.agentId,
        agentName: params.agentName,
        counterparty: params.counterparty,
        ledgerClass: params.ledgerClass,
        residual: 0n,
        candidates: [],
      };
      buckets.set(params.key, bucket);
    }
    bucket.residual += params.available;
    // Rows arrive oldest-first, so pushing preserves FIFO order.
    bucket.candidates.push({
      sourceId: params.sourceId,
      available: params.available,
      ledgerDay: params.ledgerDay,
    });
  };

  for (const row of readLedgerPayments(companyId)) {
    const amount = BigInt(row.amount_base_units);
    const vendorHost = vendorFromResourceUrl(row.resource_url);
    const currentClass = ledgerClassFor(row.status);
    const absorbed: Record<SpendClass, bigint> = {
      expense: BigInt(row.absorbed_expense),
      suspense: BigInt(row.absorbed_suspense),
    };

    // SPEND_CLASSES, not LEDGER_CLASSES. This function reads `payments`, and a
    // payment can never be owed to `revenue` — ledgerClassFor never returns it.
    // Iterating every class would mint an empty revenue bucket per payment
    // whose "absorbed" figure describes nothing, and the residual arithmetic
    // would then be carrying a number with no source behind it.
    for (const ledgerClass of SPEND_CLASSES) {
      const owed = currentClass === ledgerClass ? amount : 0n;
      const available = owed - absorbed[ledgerClass];
      // Fully absorbed and still where it was, or never involved with this
      // class at all. Either way it has nothing to contribute.
      if (available === 0n) continue;

      accumulate({
        // Spend buckets on the vendor host, which IS the counterparty — there
        // is no separate identity to key on.
        key: keyOf(row.agent_id, vendorHost, ledgerClass),
        agentId: row.agent_id,
        agentName: row.agent_name,
        counterparty: vendorHost,
        ledgerClass,
        available,
        sourceId: row.id,
        ledgerDay: row.ledger_date.slice(0, 10),
      });
    }
  }

  for (const row of readLedgerReceipts(companyId)) {
    const amount = BigInt(row.amount_base_units);
    // A receipt is owed to `revenue` exactly when it is ledger-eligible. There
    // is no receipt equivalent of ledgerClassFor because there is only one earn
    // class — 0012 refuses a revenue suspense, so a receipt is either in the
    // books or not in them, never provisionally somewhere.
    const eligible = APPEARS_IN_RECEIPT_LEDGER.includes(`'${row.status}'`);
    const absorbed = BigInt(row.absorbed_revenue);

    for (const ledgerClass of EARN_CLASSES) {
      const owed = eligible ? amount : 0n;
      const available = owed - absorbed;
      if (available === 0n) continue;

      accumulate({
        // THE KEY IS THE ENDPOINT ID; THE COUNTERPARTY IS ITS LABEL. Those are
        // different values doing different jobs, and conflating them is what
        // would make a rename dangerous. Keyed on the id, a rename changes what
        // future lines are CALLED and nothing about what any bucket owes.
        // Keyed on the label, a rename would split one endpoint's residual in
        // two and the arithmetic would follow the name around. REVIEW: claim 1.
        key: keyOf(row.agent_id, row.endpoint_id ?? UNATTRIBUTED_COUNTERPARTY, ledgerClass),
        agentId: row.agent_id,
        agentName: row.agent_name,
        // A receipt with no endpoint cannot be named, and counterparty is NOT
        // NULL. It posts under the sentinel rather than being refused, so one
        // unattributable row cannot stop the books for everyone —
        // verifyPostingIntegrity is what makes it visible. REVIEW: claim 2.
        counterparty: row.counterparty ?? UNATTRIBUTED_COUNTERPARTY,
        ledgerClass,
        available,
        sourceId: row.id,
        ledgerDay: row.ledger_date.slice(0, 10),
      });
    }
  }

  return [...buckets.values()];
}

export interface RunTotals {
  linesCreated: number;
  /** Net base units posted across every line, expense and suspense together. */
  baseUnitsPosted: bigint;
  /** Buckets that had spend but not yet a full cent of it. */
  bucketsCarried: number;
}

/**
 * What one run did, for the one company it ran for.
 *
 * There is no per-company breakdown because there is nothing to break down: a
 * run cannot contain another company's lines. Until 7A-3 it could — the run was
 * global — and this type carried a `byCompany` map so the route could report
 * the caller's share while withholding the rest. Attribution is now structural,
 * so the map and the helper that read it are gone rather than left as a second,
 * redundant account of the same fact.
 */
export interface PostingRunResult extends RunTotals {
  /** Names exactly one company's lines. */
  runId: string;
}

/**
 * Posts everything of ONE company's that has cleared a cent, in one transaction.
 *
 * ONE TRANSACTION IS NOT TIDINESS. Because `posted` is derived from
 * `export_postings`, a line committed without its absorption rows leaves the
 * residual unchanged — and the next run would post the same money a second
 * time. The absorptions committed without their line would be the opposite
 * error. Both or neither, which is what BEGIN IMMEDIATE gives.
 *
 * THE READ HAPPENS AFTER THE LOCK, and that ordering is what makes a second,
 * concurrent run harmless. `PRAGMA busy_timeout` makes a second process WAIT for
 * the write lock rather than fail, so if the buckets were computed before
 * `BEGIN IMMEDIATE`, both processes would see the same residual, and the one
 * that waited would post it again once the first committed. Read under the
 * lock, the second recomputes, finds sub-cent residuals, and posts nothing. As
 * in reserveIfUnderCap, this is written to be correct on its own terms rather
 * than leaning on node:sqlite being a single synchronous connection — within
 * one process JavaScript would serialise two calls anyway, so only a
 * cross-process test can prove it (scripts/verify-migration.ts).
 *
 * ONE COMPANY PER RUN, AND THE PARAMETER IS REQUIRED. Until 7A-3 this took no
 * argument and posted every company's books in one transaction. That had three
 * consequences a second company made real:
 *
 *   1. One company's operator created ANOTHER company's ledger lines,
 *      attributed to a run that company never started — breaking the promise
 *      the route makes that every run is a deliberate operator action.
 *   2. One bad row anywhere failed every company's run, which is the tradeoff
 *      verifyPostingIntegrity's check 3c had to design around.
 *   3. A run id spanned tenants, so the handle an operator uses to ask "what
 *      happened" did not say whose books it touched.
 *
 * A company's books now advance only when its own run is triggered. That is the
 * intended semantics rather than a regression: posting is deliberately
 * on-demand, never on the reaper loop. Non-defaultable for the reason
 * computeBuckets gives — a default is this bug reintroduced silently on the first
 * caller that omits it.
 *
 * RECLASSIFICATION HAPPENS HERE WITH NO CODE OF ITS OWN. When an unreconciled
 * payment settles, its suspense bucket stops owing what it has already posted
 * and its expense bucket starts owing what it has not. Those show up as a
 * negative and a positive residual, and this loop posts both without knowing
 * anything about reclassification: a credit releasing suspense, a debit landing
 * in expenses. That is the journal entry 0007 describes, and it falls out of
 * deriving the residual rather than storing it.
 */
export function runPosting(companyId: string): PostingRunResult {
  const runId = randomUUID();
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    // Read inside the transaction, so the residuals posted against are the ones
    // that hold under the write lock rather than a snapshot from before it.
    const buckets = computeBuckets(companyId);

    const insertLine = db.prepare(
      `INSERT INTO posting_lines
         (id, run_id, agent_id, counterparty, posting_day, ledger_class, amount_base_units, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // TWO STATEMENTS, ONE PER SOURCE COLUMN. A single statement with both
    // columns and a NULL for the unused one would work, and would also be the
    // shape in which a wrong `sourceKindFor` result writes a receipt id into
    // payment_id: both are TEXT, and the CHECK only requires that exactly one
    // is set, not that the right one is. Separate statements mean the foreign
    // key decides — a receipt id in payment_id has no matching payments row and
    // the insert fails inside the transaction.
    const insertPaymentAbsorption = db.prepare(
      `INSERT INTO export_postings (payment_id, line_id, absorbed_base_units)
       VALUES (?, ?, ?)`,
    );
    const insertReceiptAbsorption = db.prepare(
      `INSERT INTO export_postings (receipt_id, line_id, absorbed_base_units)
       VALUES (?, ?, ?)`,
    );

    let linesCreated = 0;
    let baseUnitsPosted = 0n;
    let bucketsCarried = 0;

    for (const bucket of buckets) {
      const { postable } = clearable(bucket.residual);
      if (postable === 0n) {
        // Real spend, just not a cent of it yet. Waiting is the correct
        // behaviour, not a failure: no accounting system can hold a fraction
        // of a cent, so the alternative to carrying it is losing it.
        bucketsCarried += 1;
        continue;
      }

      const absorptions = planAbsorption(postable, bucket.candidates);
      const lineId = randomUUID();

      insertLine.run(
        lineId,
        runId,
        bucket.agentId,
        bucket.counterparty,
        postingDayFor(absorptions),
        bucket.ledgerClass,
        postable,
        now,
      );
      const insertAbsorption =
        sourceKindFor(bucket.ledgerClass) === "receipt"
          ? insertReceiptAbsorption
          : insertPaymentAbsorption;
      for (const absorption of absorptions) {
        insertAbsorption.run(absorption.sourceId, lineId, absorption.absorbed);
      }

      linesCreated += 1;
      baseUnitsPosted += postable;
    }

    db.exec("COMMIT");
    return { runId, linesCreated, baseUnitsPosted, bucketsCarried };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  }
}

export interface PostingLine {
  id: string;
  runId: string;
  agentId: string;
  agentName: string;
  counterparty: string;
  postingDay: string;
  ledgerClass: LedgerClass;
  amountBaseUnits: bigint;
  createdAt: string;
  /**
   * How many sources this line was made of — payments for spend, receipts for
   * revenue.
   *
   * It was `paymentCount`, and it counted `ep.payment_id`, which is NULL on
   * every revenue absorption. So a revenue line reported ZERO sources: a `0` in
   * the postings CSV and "Agent API revenue — 0 payment(s)" in a posted
   * JournalEntry. No error, no empty result, just a wrong number in a document
   * that under 0008 is never edited afterwards.
   */
  sourceCount: number;
}

interface PostingLineRow {
  id: string;
  run_id: string;
  agent_id: string;
  agent_name: string;
  counterparty: string;
  posting_day: string;
  ledger_class: LedgerClass;
  amount_base_units: number | bigint;
  created_at: string;
  source_count: number | bigint;
}

/**
 * Counts absorptions rather than payments.
 *
 * `COUNT(ep.line_id)` and not `COUNT(ep.payment_id)`: `line_id` is NOT NULL on
 * every row of export_postings whichever source it names, so this counts what
 * a line is actually made of. Kept as one constant so the two queries that use
 * it cannot drift into counting different things.
 */
const SOURCE_COUNT = "COUNT(ep.line_id) AS source_count";

function toPostingLine(row: PostingLineRow): PostingLine {
  return {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    counterparty: row.counterparty,
    postingDay: row.posting_day,
    ledgerClass: row.ledger_class,
    amountBaseUnits: BigInt(row.amount_base_units),
    createdAt: row.created_at,
    sourceCount: Number(row.source_count),
  };
}

/**
 * Posted lines in a date range, oldest first.
 *
 * Bounds are inclusive whole days compared as strings, matching
 * listPaymentsForExport — `posting_day` is stored as a bare YYYY-MM-DD, so no
 * time component has to be reasoned about here.
 */
export function listPostingLines(opts: {
  /**
   * REQUIRED, and first in the shape, so no caller reaches this without having
   * decided whose books it is reading — the same construction
   * `listPaymentsForExport` uses, and for the same reason. It is a field on an
   * options object rather than a positional argument because this function
   * already takes one, and a caller that can pass `{ from, to }` without a
   * company should not compile.
   */
  companyId: string;
  from?: string;
  to?: string;
}): PostingLine[] {
  // First in the array, so the scope predicate is present in every query this
  // function can build rather than depending on a later branch being taken.
  const where: string[] = ["t.company_id = ?"];
  const params: string[] = [opts.companyId];

  if (opts.from) {
    where.push("pl.posting_day >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    where.push("pl.posting_day <= ?");
    params.push(opts.to);
  }

  const rows = db
    .prepare(
      `SELECT pl.*, a.name AS agent_name, ${SOURCE_COUNT}
       FROM posting_lines pl
       JOIN agents a ON a.id = pl.agent_id
       JOIN teams  t ON t.id = a.team_id
       LEFT JOIN export_postings ep ON ep.line_id = pl.id
       WHERE ${where.join(" AND ")}
       GROUP BY pl.id
       ORDER BY pl.posting_day ASC, pl.counterparty ASC, pl.id ASC`,
    )
    .all(...(params as never[])) as unknown as PostingLineRow[];

  return rows.map(toPostingLine);
}

/**
 * One payment beneath a posted line — and the decision that authorized it.
 *
 * The approval fields are what separate this from a billing pipeline's
 * line-item breakdown. A pipeline that reconciles charges after the fact can
 * say a payment happened; only Fuel can say it happened because an operator
 * granted a named, single-use exemption at a particular moment, or because it
 * fit inside every cap without anyone being asked.
 */
export interface LineConstituent {
  sourceId: string;
  /**
   * Which table `sourceId` names, so a caller never has to infer it from
   * whether `authorizedBy` happens to be null.
   */
  sourceKind: "payment" | "receipt";
  agentId: string;
  agentName: string;
  amountBaseUnits: bigint;
  /** How much of that amount THIS line took. Less than the full amount when split. */
  absorbedBaseUnits: bigint;
  ledgerDate: string;
  status: PaymentStatus | ReceiptStatus;
  /**
   * Null when the payment needed no exemption — it fit inside every cap.
   *
   * ALWAYS null for a receipt, and that is a real difference rather than
   * missing data. Approvals are a spend control: money arriving was never
   * authorised by anyone at Fuel, so there is no decision to show. The field
   * stays on the shape so one drill-down renders both kinds.
   */
  authorizedBy: {
    approvalId: string;
    blockedScope: string;
    decidedAt: string | null;
  } | null;
}

export interface PostingLineDetail extends PostingLine {
  constituents: LineConstituent[];
}

/**
 * A posted line, resolved back into the sources it was made of.
 *
 * Deliberately carries no transaction hash, wallet address, chain or asset name,
 * and no `payments.detail` — held to the no-crypto rule in
 * docs/decisions/0006, not to the narrow dashboard exception in 0005. This is
 * accounting-facing output, and 0006's argument applies to it directly: the
 * reconciliation handle is the Fuel payment id, which resolves to an on-chain
 * record internally without that record ever reaching an accountant.
 *
 * THE SAME RULE APPLIES HARDER TO RECEIPTS, because a receipt row carries two
 * things a payment row does not: `payer_address` and `tx_hash`. Neither is
 * selected below, and that is not incidental — a payer's address is a wallet
 * address belonging to a stranger, in a file a customer's accountant reads.
 *
 * TWO QUERIES, ONE PER SOURCE TABLE. This was a single query with
 * `JOIN payments p ON p.id = ep.payment_id` — an INNER join. Once payment_id
 * became nullable, every receipt-sourced absorption failed that join and
 * dropped out, so a revenue line drilled down to an EMPTY constituent list
 * while still reporting its amount. Not an error, not an exception: a line that
 * looked like it was made of nothing. Splitting means each query joins a column
 * that is NOT NULL within its own branch. Same fix, same reason, as check 3 in
 * verifyPostingIntegrity.
 */
export function drillDown(lineId: string, companyId: string): PostingLineDetail | null {
  /*
   * `companyId` SECOND, not first, and deliberately so. This codebase splits
   * the convention by family: a collection read takes the company first
   * (`listAgentsInCompany(companyId)`), and a get-by-id takes it second
   * (`getAgentInCompany(id, companyId)`) because that is the order the name
   * reads in. Both parameters are `string`, so a flipped pair is silent — which
   * is exactly why the convention is worth following rather than improving.
   *
   * SCOPED IN THE QUERY, NOT CHECKED AFTER IT. A row belonging to another
   * company returns null here, so the route's 404 is produced by the SQL rather
   * than by a branch someone remembered to write — the same construction
   * `getAgentInCompany` uses and for the same reason. Until 7A-1 this function
   * took a bare line id and checked nothing: it returned agent names,
   * per-payment amounts and the human who approved each one, to any operator.
   */
  const lineRow = db
    .prepare(
      `SELECT pl.*, a.name AS agent_name, ${SOURCE_COUNT}
       FROM posting_lines pl
       JOIN agents a ON a.id = pl.agent_id
       JOIN teams  t ON t.id = a.team_id
       LEFT JOIN export_postings ep ON ep.line_id = pl.id
       WHERE pl.id = ? AND t.company_id = ?
       GROUP BY pl.id`,
    )
    .get(lineId, companyId) as PostingLineRow | undefined;

  if (lineRow === undefined) return null;

  interface ConstituentRow {
    id: string;
    agent_id: string;
    agent_name: string;
    amount_base_units: number | bigint;
    absorbed_base_units: number | bigint;
    ledger_date: string;
    status: PaymentStatus | ReceiptStatus;
    approval_id: string | null;
    approval_scope: string | null;
    approval_decided_at: string | null;
  }

  const paymentRows = db
    .prepare(
      `SELECT p.id,
              p.agent_id,
              a.name                            AS agent_name,
              p.amount_base_units,
              ep.absorbed_base_units,
              COALESCE(p.settled_at, p.created_at) AS ledger_date,
              p.status,
              ar.id                             AS approval_id,
              ar.blocked_scope                  AS approval_scope,
              ar.decided_at                     AS approval_decided_at
       FROM export_postings ep
       JOIN payments p ON p.id = ep.payment_id
       JOIN agents a   ON a.id = p.agent_id
       -- The authorization trail. LEFT because most payments need no exemption:
       -- fitting inside every cap is itself an authorization decision, just not
       -- one that required a human.
       LEFT JOIN approval_requests ar ON ar.payment_id = p.id
       WHERE ep.line_id = ? AND ep.payment_id IS NOT NULL
       ORDER BY ledger_date ASC, p.id ASC`,
    )
    .all(lineId) as unknown as ConstituentRow[];

  // No approvals join, and no payer_address or tx_hash. Both omissions are
  // deliberate; see the note above.
  const receiptRows = db
    .prepare(
      `SELECT r.id,
              r.agent_id,
              a.name                            AS agent_name,
              r.amount_base_units,
              ep.absorbed_base_units,
              COALESCE(r.settled_at, r.created_at) AS ledger_date,
              r.status,
              NULL                              AS approval_id,
              NULL                              AS approval_scope,
              NULL                              AS approval_decided_at
       FROM export_postings ep
       JOIN receipts r ON r.id = ep.receipt_id
       JOIN agents a   ON a.id = r.agent_id
       WHERE ep.line_id = ? AND ep.receipt_id IS NOT NULL
       ORDER BY ledger_date ASC, r.id ASC`,
    )
    .all(lineId) as unknown as ConstituentRow[];

  const toConstituent = (
    row: ConstituentRow,
    sourceKind: "payment" | "receipt",
  ): LineConstituent => ({
    sourceId: row.id,
    sourceKind,
    agentId: row.agent_id,
    agentName: row.agent_name,
    amountBaseUnits: BigInt(row.amount_base_units),
    absorbedBaseUnits: BigInt(row.absorbed_base_units),
    ledgerDate: row.ledger_date,
    status: row.status,
    authorizedBy:
      row.approval_id !== null && row.approval_scope !== null
        ? {
            approvalId: row.approval_id,
            blockedScope: row.approval_scope,
            decidedAt: row.approval_decided_at,
          }
        : null,
  });

  return {
    ...toPostingLine(lineRow),
    // A line is one class, so exactly one of these is ever non-empty. Both are
    // concatenated rather than one being picked by class: picking would mean
    // trusting ledger_class to agree with which id column the absorptions
    // actually use, and check 3b exists precisely because that can be violated.
    constituents: [
      ...paymentRows.map((row) => toConstituent(row, "payment")),
      ...receiptRows.map((row) => toConstituent(row, "receipt")),
    ].sort((a, b) =>
      a.ledgerDate === b.ledgerDate
        ? a.sourceId.localeCompare(b.sourceId)
        : a.ledgerDate.localeCompare(b.ledgerDate),
    ),
  };
}

export interface IntegrityProblem {
  check: string;
  detail: string;
}

/**
 * Proves the books add up, rather than assuming they do.
 *
 * The same instinct as the `PRAGMA foreign_key_check` the migrations run after
 * a table rebuild: this slice computes derived financial values, so it should
 * be able to demonstrate they are consistent instead of asking to be trusted.
 * Every check is a read; this never repairs anything, because silently
 * "fixing" a ledger is worse than reporting that it is wrong.
 *
 * The conservation check is the one that matters most. Almost any arithmetic
 * mistake anywhere in this engine — a bad rounding direction, a double
 * absorption, a dropped bucket — shows up as money appearing or vanishing
 * between the payments table and the books.
 */
/**
 * The seam, written once.
 *
 * `posting_lines` has no `company_id` column and deliberately does not get one:
 * it reaches a company the way every other table in this schema does, through
 * `-> agents -> teams`. A denormalised column would give a line two paths to a
 * company that nothing enforces must agree — the defect `qbo_draft_lines`
 * already has — and on the conservation checks below that disagreement is the
 * worst possible one, because two errors could cancel and report clean.
 *
 * Both hops are NOT NULL, so this join drops nothing.
 */
const LINE_COMPANY_JOIN = `JOIN agents a ON a.id = pl.agent_id
       JOIN teams  t ON t.id = a.team_id`;

export function verifyPostingIntegrity(companyId: string): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];

  // 1. Every line is a whole number of cents. A line that is not could never be
  //    posted to an accounting system without rounding, which is the entire
  //    problem this engine exists to avoid.
  const ragged = db
    .prepare(
      `SELECT pl.id, pl.amount_base_units FROM posting_lines pl
       ${LINE_COMPANY_JOIN}
       WHERE t.company_id = ? AND pl.amount_base_units % ? != 0`,
    )
    .all(companyId, CENT_BASE_UNITS) as unknown as {
    id: string;
    amount_base_units: number | bigint;
  }[];
  for (const row of ragged) {
    problems.push({
      check: "whole-cent lines",
      detail: `line ${row.id} posts ${row.amount_base_units} base units, not a multiple of ${CENT_BASE_UNITS}`,
    });
  }

  // 2. Each line's parts sum to its total. This is what keeps the two views of
  //    "posted" — line amounts, and the absorptions beneath them — from
  //    disagreeing. The residual is derived from the absorptions, so if these
  //    ever diverge the line amount is a number nothing else believes.
  const unbalanced = db
    .prepare(
      `SELECT pl.id, pl.amount_base_units, COALESCE(SUM(ep.absorbed_base_units), 0) AS absorbed
       FROM posting_lines pl
       ${LINE_COMPANY_JOIN}
       LEFT JOIN export_postings ep ON ep.line_id = pl.id
       WHERE t.company_id = ?
       GROUP BY pl.id
       HAVING absorbed != pl.amount_base_units`,
    )
    .all(companyId) as unknown as {
    id: string;
    amount_base_units: number | bigint;
    absorbed: number | bigint;
  }[];
  for (const row of unbalanced) {
    problems.push({
      check: "line parts sum to total",
      detail: `line ${row.id} posts ${row.amount_base_units} but its parts sum to ${row.absorbed}`,
    });
  }

  // 3. No source is absorbed for more than it is worth, in either direction.
  //    Over-absorption books money that never moved; a negative net absorption
  //    means more was credited back than was ever posted.
  //
  //    RUN ONCE PER SOURCE TABLE, and that is not tidiness. This check used to
  //    be a single query with `JOIN payments p ON p.id = ep.payment_id` — an
  //    INNER join. The moment export_postings.payment_id became nullable, every
  //    receipt-sourced row would have failed that join and dropped out of the
  //    result: the check would have gone on reporting clean while doing no
  //    checking at all on revenue. Silence, not a failure. Splitting it means
  //    each branch joins a column that is NOT NULL within its own branch, so
  //    there is no row either query can quietly discard.
  for (const source of ["payment", "receipt"] as const) {
    const idColumn = source === "payment" ? "payment_id" : "receipt_id";
    const sourceTable = source === "payment" ? "payments" : "receipts";
    const overAbsorbed = db
      .prepare(
        `SELECT s.id, s.amount_base_units, pl.ledger_class,
                SUM(ep.absorbed_base_units) AS absorbed
         FROM export_postings ep
         JOIN posting_lines pl ON pl.id = ep.line_id
         ${LINE_COMPANY_JOIN}
         JOIN ${sourceTable} s ON s.id = ep.${idColumn}
         WHERE t.company_id = ? AND ep.${idColumn} IS NOT NULL
         GROUP BY s.id, pl.ledger_class
         HAVING absorbed > s.amount_base_units OR absorbed < 0`,
      )
      .all(companyId) as unknown as {
      id: string;
      amount_base_units: number | bigint;
      ledger_class: string;
      absorbed: number | bigint;
    }[];
    for (const row of overAbsorbed) {
      problems.push({
        check: "no over-absorption",
        detail: `${source} ${row.id} (${row.amount_base_units} base units) has ${row.absorbed} absorbed into ${row.ledger_class}`,
      });
    }
  }

  // 3b. Every absorption names exactly one source. The CHECK constraint on
  //     export_postings enforces this on write, but a constraint added by a
  //     migration only governs rows written after it — and this is the join key
  //     for every integrity check above, so a row naming neither source (or
  //     both) would be invisible to check 3 rather than caught by it.
  const orphaned = db
    .prepare(
      `SELECT ep.line_id, ep.payment_id, ep.receipt_id
       FROM export_postings ep
       JOIN posting_lines pl ON pl.id = ep.line_id
       ${LINE_COMPANY_JOIN}
       WHERE t.company_id = ? AND (ep.payment_id IS NULL) = (ep.receipt_id IS NULL)`,
    )
    .all(companyId) as unknown as {
    line_id: string;
    payment_id: string | null;
    receipt_id: string | null;
  }[];
  for (const row of orphaned) {
    problems.push({
      check: "absorption names exactly one source",
      detail:
        `line ${row.line_id} has an absorption with payment_id=${row.payment_id ?? "NULL"} ` +
        `and receipt_id=${row.receipt_id ?? "NULL"}`,
    });
  }

  // 3c. Every ledger-eligible receipt names an endpoint.
  //
  //     THE VISIBLE HALF OF A DELIBERATE FALLBACK. `receipts.endpoint_id` is
  //     nullable and `posting_lines.counterparty` is not, so an unattributable
  //     receipt posts under UNATTRIBUTED_COUNTERPARTY rather than being
  //     refused — refusing would put the failure inside runPosting's
  //     transaction, where one bad row stops that company's books, spend
  //     included. (Until 7A-3 it stopped EVERY company's, because the run was
  //     global; a run is now per company, which narrows the blast radius but
  //     does not change the reasoning — a company should not lose its whole
  //     ledger to one unnamed receipt either.)
  //
  //     That trade is only defensible if the row is IMPOSSIBLE TO MISS
  //     afterwards, which is what this check is. Without it the fallback is
  //     just a quieter way to lose track of money that genuinely arrived.
  const unattributed = db
    .prepare(
      `SELECT r.id, r.amount_base_units FROM receipts r
         JOIN agents a ON a.id = r.agent_id
         JOIN teams  t ON t.id = a.team_id
        WHERE t.company_id = ?
          AND r.endpoint_id IS NULL
          AND r.status IN ${APPEARS_IN_RECEIPT_LEDGER}`,
    )
    .all(companyId) as unknown as { id: string; amount_base_units: number | bigint }[];
  for (const row of unattributed) {
    problems.push({
      check: "every booked receipt names an endpoint",
      detail:
        `receipt ${row.id} (${row.amount_base_units} base units) has no endpoint, so its ` +
        `revenue posts as "${UNATTRIBUTED_COUNTERPARTY}"`,
    });
  }

  // Computed once and used by both remaining checks: it is the most expensive
  // read here, and running it twice could also read two different snapshots.
  const buckets = computeBuckets(companyId);

  // 4. Nothing postable was left behind. After a run every bucket should hold
  //    less than a cent; more than that means a bucket was skipped.
  for (const bucket of buckets) {
    const { postable } = clearable(bucket.residual);
    if (postable !== 0n) {
      problems.push({
        check: "nothing postable left unposted",
        detail: `${bucket.agentName} / ${bucket.counterparty} / ${bucket.ledgerClass} holds a residual of ${bucket.residual}, of which ${postable} is postable`,
      });
    }
  }

  // 5. Conservation. Every base unit that belongs in the books is either posted
  //    or still carried, and nothing else is either.
  //
  //    CHECKED ONCE PER DIRECTION, NOT ONCE IN TOTAL. Summing spend and revenue
  //    into a single equation would let an error in one direction be cancelled
  //    by an error in the other and report clean — and this is the check that
  //    catches almost every arithmetic mistake in the engine, so it is the last
  //    place to accept a weaker test. Two equations over the same data are
  //    strictly harder to satisfy by accident than one. See 0012.
  const conservation: {
    direction: string;
    owedSql: string;
    classes: readonly LedgerClass[];
  }[] = [
    {
      direction: "spend",
      owedSql: `SELECT COALESCE(SUM(p.amount_base_units), 0) AS total
                FROM payments p
                JOIN agents a ON a.id = p.agent_id
                JOIN teams  t ON t.id = a.team_id
                WHERE t.company_id = ? AND p.status IN ${APPEARS_IN_LEDGER}`,
      classes: SPEND_CLASSES,
    },
    {
      direction: "earn",
      owedSql: `SELECT COALESCE(SUM(r.amount_base_units), 0) AS total
                FROM receipts r
                JOIN agents a ON a.id = r.agent_id
                JOIN teams  t ON t.id = a.team_id
                WHERE t.company_id = ? AND r.status IN ${APPEARS_IN_RECEIPT_LEDGER}`,
      classes: EARN_CLASSES,
    },
  ];

  /*
   * BOTH SIDES OF EVERY EQUATION ARE SCOPED TO THE SAME COMPANY, and that is
   * the property to protect here above all others. `owed` reads the sources and
   * `posted` reads the lines; if one carried a company predicate and the other
   * did not, this would compare one company's obligations against every
   * company's postings. It would not merely report a false discrepancy — two
   * companies' errors could cancel and report CLEAN, which is precisely the
   * failure the per-direction split above exists to prevent, reintroduced on a
   * new axis.
   */
  for (const { direction, owedSql, classes } of conservation) {
    const owed = BigInt(
      (db.prepare(owedSql).get(companyId) as { total: number | bigint }).total,
    );

    const placeholders = classes.map(() => "?").join(", ");
    const postedRow = db
      .prepare(
        `SELECT COALESCE(SUM(pl.amount_base_units), 0) AS total
         FROM posting_lines pl
         ${LINE_COMPANY_JOIN}
         WHERE t.company_id = ? AND pl.ledger_class IN (${placeholders})`,
      )
      .get(companyId, ...classes) as { total: number | bigint };
    const posted = BigInt(postedRow.total);

    const carried = buckets
      .filter((bucket) => (classes as readonly string[]).includes(bucket.ledgerClass))
      .reduce((sum, bucket) => sum + bucket.residual, 0n);

    if (posted + carried !== owed) {
      problems.push({
        check: `conservation (${direction})`,
        detail: `posted ${posted} + carried ${carried} = ${posted + carried}, but the ${direction} ledger owes ${owed}`,
      });
    }
  }

  return problems;
}
