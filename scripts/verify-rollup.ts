/**
 * Verifies the accounting rollup engine: the arithmetic, then the engine, then
 * the reclassification path that ties them together.
 *
 * SAFE BY CONSTRUCTION. This script builds a test database in the temp
 * directory (scripts/lib/test-db.ts) and points FUEL_DB_PATH at it before
 * anything that touches the database is imported. It never opens `fuel.db`. It
 * moves no funds, signs nothing, and never reaches Fireblocks or any network —
 * the rollup engine reads `payments` and writes only its own two tables.
 *
 * Why a script rather than a test file: this project has no test framework, and
 * introducing one is a convention decision that should not ride in on a slice
 * that touches money. This follows the shape scripts/pay-test-endpoint.ts
 * already established — a main() that throws on an unmet expectation and exits
 * non-zero. See docs/roadmap.md for the verification bar it is written against.
 *
 * Run:  npx tsx scripts/verify-rollup.ts
 */

import { randomBytes, randomUUID } from "node:crypto";

import { createTestDatabase } from "./lib/test-db.js";

import {
  CENT_BASE_UNITS,
  clearable,
  planAbsorption,
  postingDayFor,
  type AbsorptionCandidate,
} from "../src/accounting/rollup.js";
import { baseUnitsToWholeCents } from "../src/lib/money.js";
import { toCsv } from "../src/lib/csv.js";

let checks = 0;

function assert(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
}

function assertEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) {
    throw new Error(`FAILED: ${description}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// 1. The arithmetic, with no database in sight.
// ---------------------------------------------------------------------------

function verifyClearable(): void {
  console.log("\n== clearable: splitting a residual into postable and carried ==");

  assertEqual(CENT_BASE_UNITS, 10_000n, "a cent is 10000 base units");

  const cases: [bigint, bigint, bigint][] = [
    // residual, postable, carried
    [0n, 0n, 0n],
    [1n, 0n, 1n],
    [9_999n, 0n, 9_999n], // one base unit under a cent: nothing posts
    [10_000n, 10_000n, 0n], // exactly a cent
    [10_001n, 10_000n, 1n], // one over
    [15_000n, 10_000n, 5_000n], // one and a half cents
    [83_000n, 80_000n, 3_000n], // the whole ledger, as it stands today
    // The negative half. These are reclassification credits, not edge cases:
    // a bucket goes negative every time an unreconciled payment settles and
    // suspense stops owing what it has already posted.
    [-1n, 0n, -1n],
    [-9_999n, 0n, -9_999n],
    [-10_000n, -10_000n, 0n],
    [-10_001n, -10_000n, -1n],
    // The one that a "fix" to floor semantics would break: Math.floor(-1.5)
    // is -2, which would credit two cents against a cent and a half and
    // release more from suspense than was ever put into it.
    [-15_000n, -10_000n, -5_000n],
  ];

  for (const [residual, postable, carried] of cases) {
    const result = clearable(residual);
    assertEqual(result.postable, postable, `clearable(${residual}).postable`);
    assertEqual(result.carried, carried, `clearable(${residual}).carried`);
    // The two invariants, asserted on every case rather than reasoned about.
    assertEqual(
      result.postable + result.carried,
      residual,
      `clearable(${residual}) conserves its input`,
    );
    assert(
      (result.carried < 0n ? -result.carried : result.carried) < CENT_BASE_UNITS,
      `clearable(${residual}) carries less than a cent`,
    );
    assertEqual(
      result.postable % CENT_BASE_UNITS,
      0n,
      `clearable(${residual}) posts a whole number of cents`,
    );
  }

  console.log(`   ${cases.length} cases, both directions, invariants hold on each`);
}

function verifyAbsorption(): void {
  console.log("\n== planAbsorption: which payments a line is made of ==");

  const day = "2026-08-25";
  const candidate = (id: string, available: bigint): AbsorptionCandidate => ({
    sourceId: id,
    available,
    ledgerDay: day,
  });

  // Exact fit: ten $0.001 payments make exactly one cent.
  const exact = planAbsorption(
    10_000n,
    Array.from({ length: 10 }, (_, i) => candidate(`p${i}`, 1_000n)),
  );
  assertEqual(exact.length, 10, "exact fit absorbs all ten payments");
  assertEqual(
    exact.reduce((sum, a) => sum + a.absorbed, 0n),
    10_000n,
    "exact fit absorbs exactly a cent",
  );

  // The partial case, which real data has not produced yet but the engine must
  // handle: $0.0015 payments never sum to a whole cent until the twentieth, so
  // the seventh is split across two lines.
  const partial = planAbsorption(
    10_000n,
    Array.from({ length: 10 }, (_, i) => candidate(`p${i}`, 1_500n)),
  );
  assertEqual(partial.length, 7, "partial absorption reaches the seventh payment");
  assertEqual(partial[6]!.absorbed, 1_000n, "the seventh payment is absorbed in part");
  assertEqual(
    partial.reduce((sum, a) => sum + a.absorbed, 0n),
    10_000n,
    "partial absorption still sums to exactly a cent",
  );

  // One payment larger than the whole line.
  const single = planAbsorption(10_000n, [candidate("big", 50_000n)]);
  assertEqual(single.length, 1, "one large payment covers the line alone");
  assertEqual(single[0]!.absorbed, 10_000n, "and is absorbed only up to the line amount");

  // Nothing to post is not an error.
  assertEqual(planAbsorption(0n, []).length, 0, "zero postable absorbs nothing");

  // The negative direction: unwinding a suspense posting.
  const unwind = planAbsorption(
    -10_000n,
    Array.from({ length: 10 }, (_, i) => candidate(`p${i}`, -1_000n)),
  );
  assertEqual(unwind.length, 10, "a credit unwinds ten payments");
  assertEqual(
    unwind.reduce((sum, a) => sum + a.absorbed, 0n),
    -10_000n,
    "a credit sums to exactly minus one cent",
  );

  // Mixed signs: a bucket mid-reclassification holds payments pointing both
  // ways. Only those facing the same direction as the line may fund it.
  const mixed = planAbsorption(-10_000n, [
    candidate("still-owed", 3_000n),
    candidate("left-the-class", -13_000n),
  ]);
  assertEqual(mixed.length, 1, "a credit skips candidates facing the other way");
  assertEqual(mixed[0]!.sourceId, "left-the-class", "and takes the one that left the class");
  assertEqual(mixed[0]!.absorbed, -10_000n, "unwinding only the whole-cent part");

  // It refuses to invent money rather than silently posting a short line.
  let threw = false;
  try {
    planAbsorption(10_000n, [candidate("small", 1_000n)]);
  } catch {
    threw = true;
  }
  assert(threw, "planAbsorption throws rather than post a line its parts cannot cover");

  // Dating: the newest constituent, not the first or the clock.
  assertEqual(
    postingDayFor([
      { sourceId: "a", absorbed: 1n, ledgerDay: "2026-08-01" },
      { sourceId: "b", absorbed: 1n, ledgerDay: "2026-08-25" },
      { sourceId: "c", absorbed: 1n, ledgerDay: "2026-08-03" },
    ]),
    "2026-08-25",
    "a line is dated by its newest constituent",
  );

  console.log("   exact, partial, oversized, empty, credit, mixed-sign, refusal, dating");
}

function verifyCentFormatting(): void {
  console.log("\n== baseUnitsToWholeCents: the two-decimal column ==");

  const cases: [bigint, string][] = [
    [0n, "0.00"],
    [10_000n, "0.01"],
    [30_000n, "0.03"],
    [1_000_000n, "1.00"],
    [1_230_000n, "1.23"],
    [-20_000n, "-0.02"], // a suspense credit
    // NOT a whole cent. Degrades to full precision rather than rounding to
    // "0.00", which would silently misstate money — the exact failure this
    // entire slice exists to prevent. Ragged in a column, and visibly so.
    [1_000n, "0.001000"],
    [-1_500n, "-0.001500"],
  ];

  for (const [units, expected] of cases) {
    assertEqual(baseUnitsToWholeCents(units), expected, `baseUnitsToWholeCents(${units})`);
  }

  console.log(`   ${cases.length} cases, including negatives and the no-silent-rounding fallback`);
}

/**
 * The bug the security review caught, kept as a regression check.
 *
 * csv.ts defuses spreadsheet formula injection by prefixing any cell that
 * starts with `=`, `+`, `-` or `@` with an apostrophe. That was written when
 * nothing in the system could produce a negative amount — an assumption the
 * previous slice's review noted and accepted. This slice made it false: a
 * reclassification credit is a negative posting line, and defusing it wrote
 * `'-0.02` into the amount column, which is text, not money.
 *
 * So both halves are asserted here: credits survive as numbers, and hostile
 * text is still defused.
 */
function verifyCsvAmounts(): void {
  console.log("\n== csv: negative amounts survive, hostile text still does not ==");

  const parseRow = (csv: string, index: number) =>
    csv.replace(/^﻿/, "").trim().split("\r\n")[index]!;

  const credit = baseUnitsToWholeCents(-20_000n);
  const numbers = toCsv(
    ["Account", "Amount"],
    [
      ["Suspense", credit],
      ["Expenses", baseUnitsToWholeCents(30_000n)],
      ["Payments", "26"],
    ],
  );
  assertEqual(parseRow(numbers, 1), "Suspense,-0.02", "a credit stays a bare negative number");
  assert(
    !Number.isNaN(Number(parseRow(numbers, 1).split(",")[1])),
    "and parses back as a number rather than NaN",
  );
  assertEqual(parseRow(numbers, 2), "Expenses,0.03", "a positive amount is unchanged");
  assertEqual(parseRow(numbers, 3), "Payments,26", "a bare integer count is unchanged");

  // The defence itself, unchanged. Each of these starts with a character a
  // spreadsheet would execute and none is a plain number.
  const hostile = toCsv(
    ["Agent"],
    [
      ['=HYPERLINK("http://evil.test","Refund")'],
      ["@SUM(A1:A9)"],
      ["-1+cmd|' /C calc'!A0"],
      ["+1+1"],
    ],
  );
  for (const [index, label] of [
    [1, "=HYPERLINK"],
    [2, "@SUM"],
    [3, "-1+cmd (a minus that is NOT a plain number)"],
    [4, "+1+1"],
  ] as const) {
    assert(
      parseRow(hostile, index).includes("'"),
      `${label} is still defused with a leading apostrophe`,
    );
  }

  console.log("   credits readable; formula payloads still neutralised");
}

// ---------------------------------------------------------------------------
// 2. The engine, against the test database.
// ---------------------------------------------------------------------------

async function verifyEngine(): Promise<void> {
  const scratch = createTestDatabase("rollup");
  // Set BEFORE importing anything that touches the database: src/db/index.ts
  // reads FUEL_DB_PATH at module load and opens the file immediately.
  process.env.FUEL_DB_PATH = scratch;
  // Registering an earning endpoint encrypts a forward secret, so lib/secrets.ts
  // needs a key. A throwaway one: nothing here decrypts anything, and a real key
  // has no business in a test process.
  process.env.FUEL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  console.log(`\n== engine, against the test database at ${scratch} ==`);

  const { computeBuckets, runPosting, listPostingLines, drillDown, verifyPostingIntegrity } =
    await import("../src/db/postings.js");
  const { db, DB_PATH } = await import("../src/db/index.js");
  // TD-2. The database this process actually opened is the one just built --
  // not `fuel.db`, which src/db/index.ts falls back to if anything imported it
  // before FUEL_DB_PATH was set.
  assertEqual(DB_PATH, scratch, "TD-2: this suite opened its test database, not fuel.db");

  /*
   * WHOSE BOOKS THIS SECTION IS ABOUT.
   *
   * The engine became company-scoped in 7A-1. The test database holds three
   * companies and this section is about the first, the one with the history:
   * it says so, and the two-company section at the end of this file proves the
   * scoping actually partitions rather than merely compiling.
   */
  const COMPANY = (
    db.prepare("SELECT id FROM companies ORDER BY created_at LIMIT 1").get() as { id: string }
  ).id;

  const ledgerable = () => {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM payments
         WHERE status IN ('settled', 'unreconciled')`,
      )
      .get() as { total: number | bigint };
    return BigInt(row.total);
  };
  const postedTotal = () => {
    const row = db
      .prepare("SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM posting_lines")
      .get() as { total: number | bigint };
    return BigInt(row.total);
  };
  const carriedTotal = () => computeBuckets(COMPANY).reduce((sum, b) => sum + b.residual, 0n);

  const owed = ledgerable();
  const postedBefore = postedTotal();
  console.log(`   spend ledger owes ${owed} base units before any run`);
  console.log(`   ${postedBefore} base units already posted before this run (both directions)`);

  /**
   * Conservation, asked of the engine rather than recomputed here.
   *
   * Returns "" when both direction equations balance, and a readable summary
   * otherwise, so `assertEqual` prints what actually failed instead of a bare
   * boolean. Every conservation assertion in this file goes through this.
   */
  const conservationProblems = () =>
    verifyPostingIntegrity(COMPANY)
      .filter((p) => p.check.startsWith("conservation"))
      .map((p) => `${p.check}: ${p.detail}`)
      .join("; ");

  /*
   * CONSERVATION, NOT VIRGINITY — AND NOW NOT A SECOND COPY EITHER. Read the
   * whole of this comment before changing the assertion again; it has been
   * wrong twice, the same way, for the same reason.
   *
   * First version: `postedTotal() === 0`, an encoding of "the rollup has never
   * run against this database". True when written, false the moment the engine
   * ran for real.
   *
   * Second version: `postedTotal() + carriedTotal() === ledgerable()`. That
   * replaced one "true today" assumption with another, and the replacement was
   * harder to see: `ledgerable()` sums PAYMENTS, while `postedTotal()` sums
   * ALL of `posting_lines`. Those agree only while no revenue exists. The
   * first real revenue line — $0.05, from 6B-1's live walkthrough — made them
   * differ by exactly 50000 base units and this assertion failed, as a broken
   * test rather than a broken engine, for the second time.
   *
   * Both failures were the lesson this very file records about "true today"
   * assumptions, and the file got bitten by it twice. So the fix is not a
   * third hand-rolled equation. `verifyPostingIntegrity` already computes
   * conservation ONCE PER DIRECTION — spend against `payments`, earn against
   * `receipts` — and this script already trusts it at eight other call sites.
   * Two copies of a rule drift silently; this one drifted. Delegate instead.
   *
   * Filtered to conservation deliberately. A pre-run ledger legitimately has
   * postable material waiting (that is what the run is for), so check 4
   * "nothing postable left unposted" is expected to fire here and is not a
   * fault. Conservation is the one that must hold from ANY starting state.
   */
  assertEqual(conservationProblems(), "", "conservation holds in both directions before any run");

  // --- the run ---
  const first = runPosting(COMPANY);
  console.log(
    `   run 1: ${first.linesCreated} lines, ${first.baseUnitsPosted} posted, ` +
      `${first.bucketsCarried} buckets still under a cent`,
  );
  // Only meaningful if something was actually left to post. A database whose
  // engine has already caught up correctly creates nothing.
  assert(
    first.linesCreated > 0 || postedTotal() === postedBefore,
    "the first run either posts something or finds nothing left to post",
  );

  // THE MASTER CHECK. Almost any arithmetic mistake in this engine shows up as
  // money appearing or vanishing between the payments table and the books.
  assertEqual(
    conservationProblems(),
    "",
    "conservation: posted + carried equals what the ledger owes, per direction",
  );

  // Nothing postable left behind.
  for (const bucket of computeBuckets(COMPANY)) {
    const magnitude = bucket.residual < 0n ? -bucket.residual : bucket.residual;
    assert(
      magnitude < CENT_BASE_UNITS,
      `${bucket.agentName}/${bucket.counterparty}/${bucket.ledgerClass} carries ${bucket.residual}, under a cent`,
    );
  }

  // Every line is whole cents, and its parts sum to its total.
  const lines = listPostingLines({ companyId: COMPANY });
  for (const line of lines) {
    assertEqual(
      line.amountBaseUnits % CENT_BASE_UNITS,
      0n,
      `line ${line.id} posts a whole number of cents`,
    );
    const detail = drillDown(line.id, COMPANY)!;
    assertEqual(
      detail.constituents.reduce((sum, c) => sum + c.absorbedBaseUnits, 0n),
      line.amountBaseUnits,
      `line ${line.id}'s parts sum to its total`,
    );
    assertEqual(
      detail.constituents.length,
      line.sourceCount,
      `line ${line.id} reports its own constituent count`,
    );
  }

  assertEqual(verifyPostingIntegrity(COMPANY).length, 0, "the engine's own integrity check is clean");

  // --- idempotency ---
  const second = runPosting(COMPANY);
  assertEqual(second.linesCreated, 0, "an immediate second run posts nothing");
  assertEqual(conservationProblems(), "", "conservation survives a repeat run");

  // --- the drill-down, which is the point of the whole design ---
  const authorized = lines
    .map((line) => drillDown(line.id, COMPANY)!)
    .flatMap((detail) => detail.constituents)
    .filter((c) => c.authorizedBy !== null);
  assert(
    authorized.length > 0,
    "at least one posted payment traces back to a named approval decision",
  );
  console.log(
    `   drill-down: ${authorized.length} posted payments trace to an approval ` +
      `(${[...new Set(authorized.map((c) => c.authorizedBy!.blockedScope))].join(", ")})`,
  );

  // No crypto identifiers anywhere in the accounting surface (0006).
  const serialised = JSON.stringify(
    lines.map((l) => drillDown(l.id, COMPANY)),
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
  );
  for (const term of ["0x", "usdc", "sepolia", "chain", "wallet", "token", "facilitator", "x402"]) {
    assert(
      !serialised.toLowerCase().includes(term),
      `the drill-down carries no "${term}" (docs/decisions/0006)`,
    );
  }
  console.log("   no-crypto: drill-down output clean of chain identifiers");

  // --- reclassification: the path that justifies deriving the residual ---
  console.log("\n== reclassification: unreconciled money settling later ==");

  const suspenseBefore = lines.filter((l) => l.ledgerClass === "suspense");
  assert(suspenseBefore.length > 0, "the real data left unreconciled payments to hold in suspense");
  const target = suspenseBefore[0]!;
  const targetDetail = drillDown(target.id, COMPANY)!;
  console.log(
    `   suspense line ${target.amountBaseUnits} base units for ` +
      `${target.agentName} / ${target.counterparty}`,
  );

  // Settle every unreconciled payment in that bucket, so suspense stops owing
  // the whole amount it has posted and the correction is a full cent or more.
  const { markSettled } = await import("../src/db/payments.js");
  const stillUnreconciled = db
    .prepare(
      `SELECT p.id FROM payments p
       WHERE p.agent_id = ? AND p.status = 'unreconciled' AND p.resource_url LIKE ?`,
    )
    .all(target.agentId, `%${target.counterparty}%`) as unknown as { id: string }[];
  assert(stillUnreconciled.length > 0, "there are unreconciled payments to settle");
  for (const row of stillUnreconciled) {
    markSettled(row.id, "0x" + "0".repeat(64));
  }
  console.log(`   settled ${stillUnreconciled.length} previously-unreconciled payments`);

  const owedAfterSettle = ledgerable();
  assertEqual(owedAfterSettle, owed, "settling changes no totals — the money was always owed");

  const third = runPosting(COMPANY);
  console.log(`   run 2: ${third.linesCreated} lines, net ${third.baseUnitsPosted} posted`);

  const afterLines = listPostingLines({ companyId: COMPANY });
  const credits = afterLines.filter((l) => l.ledgerClass === "suspense" && l.amountBaseUnits < 0n);
  const newExpense = afterLines.filter(
    (l) => l.ledgerClass === "expense" && l.runId === third.runId,
  );

  assert(credits.length > 0, "a negative suspense line appears — suspense is released");
  assert(newExpense.length > 0, "and a positive expense line appears in the same run");

  const creditTotal = credits.reduce((sum, l) => sum + l.amountBaseUnits, 0n);
  const expenseTotal = newExpense.reduce((sum, l) => sum + l.amountBaseUnits, 0n);
  console.log(`   released ${creditTotal} from suspense, booked ${expenseTotal} to expenses`);

  // Conservation is the assertion that matters, and it is checked first because
  // it is the one that would catch money being invented.
  assertEqual(conservationProblems(), "", "conservation survives reclassification");

  // The credit and the debit deliberately do NOT have to cancel, and expecting
  // them to was the first mistake this script caught. The expense line absorbs
  // the reclassified money AND whatever expense residual was already carried
  // under a cent from earlier runs, so it is legitimately larger than the
  // credit. What must hold is narrower and more meaningful: once nothing in a
  // bucket is unreconciled any more, that bucket's suspense account must net to
  // zero — every cent it ever held has been released.
  const suspensePostedForBucket = db
    .prepare(
      `SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM posting_lines
       WHERE agent_id = ? AND counterparty = ? AND ledger_class = 'suspense'`,
    )
    .get(target.agentId, target.counterparty) as { total: number | bigint };
  assertEqual(
    BigInt(suspensePostedForBucket.total),
    0n,
    "suspense nets to zero for a bucket with nothing unreconciled left in it",
  );

  // And the money did not evaporate: it moved to expenses. Everything that
  // bucket is owed now sits in the expense account, bar the sub-cent remainder.
  const bucketOwed = db
    .prepare(
      `SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM payments
       WHERE agent_id = ? AND resource_url LIKE ? AND status IN ('settled', 'unreconciled')`,
    )
    .get(target.agentId, `%${target.counterparty}%`) as { total: number | bigint };
  const expensePostedForBucket = db
    .prepare(
      `SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM posting_lines
       WHERE agent_id = ? AND counterparty = ? AND ledger_class = 'expense'`,
    )
    .get(target.agentId, target.counterparty) as { total: number | bigint };
  const bucketRemainder = BigInt(bucketOwed.total) - BigInt(expensePostedForBucket.total);
  console.log(
    `   bucket now owes ${bucketOwed.total}, expenses hold ${expensePostedForBucket.total}, ` +
      `${bucketRemainder} still under a cent`,
  );
  assert(
    bucketRemainder >= 0n && bucketRemainder < CENT_BASE_UNITS,
    "all reclassified money reached the expense account bar a sub-cent remainder",
  );
  assertEqual(
    verifyPostingIntegrity(COMPANY).length,
    0,
    "integrity is clean after reclassification",
  );

  // The credit's parts must be negative absorptions of the payments that left.
  for (const credit of credits) {
    const detail = drillDown(credit.id, COMPANY)!;
    assertEqual(
      detail.constituents.reduce((sum, c) => sum + c.absorbedBaseUnits, 0n),
      credit.amountBaseUnits,
      "the credit's parts sum to the credit",
    );
    assert(
      detail.constituents.every((c) => c.absorbedBaseUnits < 0n),
      "every part of a credit is itself a credit",
    );
  }

  // --- revenue: the earn side, exercised for the first time ---
  //
  // THE ROADMAP'S OWN WARNING, DISCHARGED HERE. Until this point the earn
  // conservation equation compared zero to zero and had never run its own logic
  // once. "It passes" was not evidence of anything. Everything below puts a
  // real settled receipt on one side of it.
  console.log("\n== revenue: the earn side, with non-zero on both sides at last ==");

  const {
    registerEndpoint,
    setLabel,
    UNATTRIBUTED_COUNTERPARTY,
  } = await import("../src/db/earning-endpoints.js");

  const revenueOwed = () => {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM receipts WHERE status = 'settled'",
      )
      .get() as { total: number | bigint };
    return BigInt(row.total);
  };
  const revenuePosted = () => {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(amount_base_units), 0) AS total FROM posting_lines WHERE ledger_class = 'revenue'",
      )
      .get() as { total: number | bigint };
    return BigInt(row.total);
  };
  const revenueCarried = () =>
    computeBuckets(COMPANY)
      .filter((b) => b.ledgerClass === "revenue")
      .reduce((sum, b) => sum + b.residual, 0n);

  /*
   * BASELINE, NOT ZERO — the third time this file has been bitten by the same
   * thing, and the second time in this one run.
   *
   * This asserted `revenueOwed() === 0`, an encoding of "no revenue has ever
   * existed in the live database". True when written; false from the moment
   * 6B-1's live walkthrough put a real settled receipt into `fuel.db`, which
   * this script then copied. Same shape as the two conservation assertions above,
   * and the same shape as `postedTotal() === 0` before them.
   *
   * The durable fix is the one verify-quickbooks already arrived at: do not
   * depend on the live database's leftovers at all. Everything below is scoped
   * to the endpoints and receipts this section creates for itself, so it is
   * correct whatever the database it runs on contains — including the revenue
   * the test database holds, as the real one does.
   */
  const revenueOwedBefore = revenueOwed();
  console.log(`   revenue already in the test database: ${revenueOwedBefore} base units`);

  /** The two labels this section owns. Nothing else may be asserted on. */
  const SEEDED = ["Forecast API", "History API"];

  const earner = db.prepare("SELECT id, name FROM agents LIMIT 1").get() as {
    id: string;
    name: string;
  };
  const endpointA = registerEndpoint({
    agentId: earner.id,
    originUrl: "https://origin.example.com/forecast",
    priceBaseUnits: 3000n,
    label: "Forecast API",
  }).endpoint;
  const endpointB = registerEndpoint({
    agentId: earner.id,
    originUrl: "https://origin.example.com/history",
    priceBaseUnits: 3000n,
    label: "History API",
  }).endpoint;

  let nonce = 0;
  const seedReceipt = (endpointId: string | null, amount: bigint, day: string): string => {
    const id = `rec-${(nonce += 1)}`;
    db.prepare(
      `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status,
                             payer_address, authorization_nonce, tx_hash, created_at, settled_at)
       VALUES (?, ?, ?, ?, 'settled', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      earner.id,
      endpointId,
      amount,
      `0xpayer${nonce}`,
      `0xnonce${nonce}`,
      "0x" + "b".repeat(64),
      `${day}T00:00:00.000Z`,
      `${day}T00:00:00.000Z`,
    );
    return id;
  };

  // Sub-cent amounts at ONE endpoint (a cent is 10,000 base units, each receipt
  // is 3,000), so the first assertion is that they ACCUMULATE rather than each
  // being lost or each posting a rounded cent. Four of them clear one cent and
  // leave 2,000 carried.
  for (let i = 0; i < 4; i += 1) seedReceipt(endpointA.id, 3000n, "2026-09-02");
  // A fifth at a DIFFERENT endpoint, which must not join the same bucket even
  // though it is the same agent, the same day and the same amount.
  seedReceipt(endpointB.id, 3000n, "2026-09-02");

  const revBuckets = computeBuckets(COMPANY).filter(
    (b) => b.ledgerClass === "revenue" && SEEDED.includes(b.counterparty),
  );
  assertEqual(revBuckets.length, 2, "two endpoints produce two revenue buckets, not one");
  const bucketA = revBuckets.find((b) => b.counterparty === "Forecast API")!;
  const bucketB = revBuckets.find((b) => b.counterparty === "History API")!;
  assertEqual(bucketA.residual, 12000n, "one endpoint's sub-cent revenue accumulates");
  assertEqual(bucketB.residual, 3000n, "the other endpoint's stays separate");

  const revRun = runPosting(COMPANY);
  console.log(`   revenue run: ${revRun.linesCreated} lines, ${revRun.baseUnitsPosted} net posted`);

  const revLines = listPostingLines({ companyId: COMPANY }).filter(
    (l) => l.ledgerClass === "revenue" && SEEDED.includes(l.counterparty),
  );
  assertEqual(revLines.length, 1, "only the bucket that cleared a cent posts");
  const revLine = revLines[0]!;
  assertEqual(revLine.counterparty, "Forecast API", "the line is named by the endpoint's label");
  assertEqual(revLine.amountBaseUnits, 10000n, "it posts the whole cent and carries the rest");
  assertEqual(revLine.sourceCount, 4, "made of four receipts, the last one absorbed in part");

  // --- THE EARN CONSERVATION EQUATION, non-zero for the first time ---
  assertEqual(
    revenuePosted() + revenueCarried(),
    revenueOwed(),
    "EARN CONSERVATION: revenue posted + carried equals what receipts owe",
  );
  assert(revenueOwed() > 0n, "and it is a real equation now, not 0 = 0");
  assertEqual(verifyPostingIntegrity(COMPANY).length, 0, "integrity is clean with revenue in the books");

  // Spend conservation must be untouched by any of this. Two equations, and an
  // error in one must not be absorbable by the other — which is the entire
  // reason 0012 refused a single combined check.
  assertEqual(
    postedTotal() - revenuePosted() + (carriedTotal() - revenueCarried()),
    owed,
    "spend conservation is unaffected by revenue existing",
  );

  // --- the silent drops, each pinned ---
  const revDetail = drillDown(revLine.id, COMPANY)!;
  assert(
    revDetail.constituents.length > 0,
    "a revenue line drills down to its receipts — an inner join on payment_id returned NOTHING here",
  );
  assertEqual(
    revDetail.constituents.length,
    revLine.sourceCount,
    "and sourceCount agrees — COUNT(ep.payment_id) reported 0 for every revenue line",
  );
  assert(
    revDetail.constituents.every((c) => c.sourceKind === "receipt"),
    "every constituent of a revenue line is a receipt",
  );
  assert(
    revDetail.constituents.every((c) => c.authorizedBy === null),
    "and none carries an approval — money arriving was never authorised by anyone at Fuel",
  );
  assertEqual(
    revDetail.constituents.reduce((sum, c) => sum + c.absorbedBaseUnits, 0n),
    revLine.amountBaseUnits,
    "a revenue line's parts sum to its total",
  );

  // 0006, on the surface where a receipt could actually breach it. A receipt
  // row carries payer_address AND tx_hash — two crypto identifiers a payment
  // row does not have in the same place — so the revenue drill-down is the
  // strictest test this rule has. The identical term list to the spend check
  // above, deliberately: the earlier one ran over `lines`, captured before any
  // revenue existed, so it never saw a revenue line at all.
  const revSerialised = JSON.stringify(revDetail, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  ).toLowerCase();
  for (const term of ["0x", "usdc", "sepolia", "chain", "wallet", "token", "facilitator", "x402"]) {
    assert(
      !revSerialised.includes(term),
      `the revenue drill-down carries no "${term}" (docs/decisions/0006)`,
    );
  }

  // --- break tests: the guards must be observed to FAIL ---
  //
  // ADR 0012 IS WRONG ABOUT WHICH CHECK CATCHES THIS, and it says so twice:
  //
  //   "This is the invariant that would catch a revenue line mistakenly
  //    absorbing a payment"
  //   "The conservation check becomes the phase's best safety net. It is the
  //    one thing that would catch a revenue line absorbing a payment"
  //
  // It is not. Conservation compares owed against posted + carried, and BOTH
  // readers filter absorptions by the LINE's class matching their own
  // direction: readLedgerPayments counts only expense/suspense lines,
  // readLedgerReceipts only revenue lines with a non-null receipt_id. A PAYMENT
  // absorbed under a REVENUE line matches neither, so it changes no term in
  // either equation. Both still balance.
  //
  // The ledger is not unguarded — "line parts sum to total" catches it, because
  // the line's own amount no longer equals the sum beneath it. But that is a
  // different check with different coverage, and someone reasoning from 0012
  // would believe conservation covered a case it structurally cannot. Verified
  // by running it, which is the only reason it was found. 0012 is amended.
  const strayPayment = db
    .prepare("SELECT id FROM payments WHERE status = 'settled' LIMIT 1")
    .get() as { id: string };
  db.prepare(
    "INSERT INTO export_postings (payment_id, line_id, absorbed_base_units) VALUES (?, ?, 1)",
  ).run(strayPayment.id, revLine.id);
  const strayProblems = verifyPostingIntegrity(COMPANY);
  assert(
    strayProblems.some((p) => p.check === "line parts sum to total"),
    "BREAK TEST: a payment absorbed into a revenue line is caught by 'line parts sum to total'",
  );
  assert(
    !strayProblems.some((p) => p.check.startsWith("conservation")),
    "and NOT by conservation, which is what 0012 claims — pinned so the correction cannot rot",
  );
  db.prepare("DELETE FROM export_postings WHERE payment_id = ? AND line_id = ?").run(
    strayPayment.id,
    revLine.id,
  );
  assertEqual(verifyPostingIntegrity(COMPANY).length, 0, "and removing it restores a clean ledger");

  // THE OVER-ABSORPTION CHECK, ON ITS RECEIPT BRANCH, FOR THE FIRST TIME.
  // 0012 named this one specifically: under the old inner join every
  // receipt-sourced row dropped out and the check reported clean while doing no
  // checking at all. 6A-1 split it per source — but with no receipts in
  // existence, the receipt branch has never once had a row to examine. This is
  // the first time it is asked a question it could get wrong.
  const firstReceipt = drillDown(revLine.id, COMPANY)!.constituents[0]!;
  db.prepare(
    `INSERT INTO posting_lines
       (id, run_id, agent_id, counterparty, posting_day, ledger_class, amount_base_units, created_at)
     VALUES ('line-double', 'run-break', ?, 'Forecast API', '2026-09-02', 'revenue', ?, ?)`,
  ).run(earner.id, firstReceipt.absorbedBaseUnits, new Date().toISOString());
  db.prepare(
    "INSERT INTO export_postings (receipt_id, line_id, absorbed_base_units) VALUES (?, 'line-double', ?)",
  ).run(firstReceipt.sourceId, firstReceipt.absorbedBaseUnits);
  const doubleProblems = verifyPostingIntegrity(COMPANY);
  assert(
    doubleProblems.some((p) => p.check === "no over-absorption" && p.detail.startsWith("receipt ")),
    "BREAK TEST: a receipt absorbed twice is caught by the receipt branch of the over-absorption check",
  );
  db.prepare("DELETE FROM export_postings WHERE line_id = 'line-double'").run();
  db.prepare("DELETE FROM posting_lines WHERE id = 'line-double'").run();
  assertEqual(verifyPostingIntegrity(COMPANY).length, 0, "and the ledger is clean again");

  // WHY CONSERVATION SURVIVED BOTH OF THOSE, stated rather than left as a
  // puzzle. The residual is DERIVED, not stored (0007's founding decision), so
  // a bad absorption row moves `posted` and `carried` by the same amount in
  // opposite directions and the equation re-balances itself. That is the design
  // working, not the check being weak: conservation catches errors in the
  // ENGINE'S ARITHMETIC — a dropped bucket, a bad rounding direction, a residual
  // computed against the wrong source — which is what it was written for and
  // what no amount of row surgery can simulate.
  assertEqual(
    revenuePosted() + revenueCarried(),
    revenueOwed(),
    "earn conservation is unmoved by row surgery, because the residual is derived",
  );

  // --- an unattributable receipt is named, not refused, and reported ---
  const orphan = seedReceipt(null, 20000n, "2026-09-03");
  const orphanBucket = computeBuckets(COMPANY).find(
    (b) => b.ledgerClass === "revenue" && b.counterparty === UNATTRIBUTED_COUNTERPARTY,
  );
  assert(orphanBucket !== undefined, "a receipt with no endpoint still buckets, under the sentinel");
  const orphanProblems = verifyPostingIntegrity(COMPANY);
  assert(
    orphanProblems.some((p) => p.check === "every booked receipt names an endpoint"),
    "and integrity reports it rather than letting it pass quietly",
  );
  runPosting(COMPANY);
  assertEqual(
    revenuePosted() + revenueCarried(),
    revenueOwed(),
    "earn conservation still holds with an unattributable receipt booked",
  );
  db.prepare("DELETE FROM export_postings WHERE receipt_id = ?").run(orphan);
  db.prepare("DELETE FROM receipts WHERE id = ?").run(orphan);
  db.prepare(
    `DELETE FROM posting_lines WHERE ledger_class = 'revenue' AND counterparty = ?`,
  ).run(UNATTRIBUTED_COUNTERPARTY);

  // --- a rename moves no money (REVIEW: claim 1) ---
  const beforeRename = { posted: revenuePosted(), carried: revenueCarried() };
  setLabel(endpointA.id, "Forecast API v2");
  assertEqual(revenuePosted(), beforeRename.posted, "a rename posts nothing and unposts nothing");
  assertEqual(
    revenueCarried(),
    beforeRename.carried,
    "and the residual is unchanged — buckets key on the endpoint id, not the name",
  );
  assertEqual(
    revenuePosted() + revenueCarried(),
    revenueOwed(),
    "earn conservation survives a rename",
  );
  assertEqual(
    listPostingLines({ companyId: COMPANY }).filter((l) => l.counterparty === "Forecast API").length,
    revLines.length,
    "the already-posted line keeps the OLD name — posting_lines is append-only",
  );
  const renamedBucket = computeBuckets(COMPANY).find(
    (b) => b.ledgerClass === "revenue" && b.counterparty === "Forecast API v2",
  );
  assert(renamedBucket !== undefined, "while the live bucket now carries the new one");
  assertEqual(verifyPostingIntegrity(COMPANY).length, 0, "integrity is clean after a rename");

  /* ---- two companies, and the partition between them ------------------- */
  /*
   * THE ORACLE IS MADE TENANT-AWARE BEFORE THE ENGINE IT VALIDATES.
   *
   * `verifyPostingIntegrity` is what proves `runPosting` correct, so scoping
   * both in one change would have left a green suite proving nothing. The
   * checker was scoped first, in 7A-1, while the run stayed global; this
   * section proved the checker partitions, and only then — 7A-3 — did the run
   * follow it. Both are per company now, and step 4 below drives the engine
   * one company at a time.
   *
   * What this section proves is that the scoping PARTITIONS rather than merely
   * compiling: every bucket lands under exactly one company, none is dropped,
   * and none is counted twice. If that holds, per-company conservation is a
   * true statement about each company's books rather than an accident of there
   * having been only one.
   */
  console.log("\n== two companies: the scoping partitions, and conservation holds per company ==");
  {
    const otherCompany = randomUUID();
    const otherTeam = randomUUID();
    const otherAgent = randomUUID();
    const otherName = `rollup-other-${otherCompany.slice(0, 8)}`;

    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO companies (id, name, spend_cap_base_units, created_at)
       VALUES (?, ?, 1000000, '2099-01-01T00:00:00.000Z')`,
    ).run(otherCompany, `Rollup Other ${otherCompany.slice(0, 8)}`);
    db.prepare(
      `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
       VALUES (?, ?, 'Other Team', 1000000, '2099-01-01T00:00:00.000Z')`,
    ).run(otherTeam, otherCompany);
    db.prepare(
      `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                           spend_cap_base_units, created_at)
       VALUES (?, ?, ?, 'vault-other', '0xother', 1000000, '2099-01-01T00:00:00.000Z')`,
    ).run(otherAgent, otherName, otherTeam);
    // Deliberately a whole number of cents, so it is POSTABLE rather than
    // sitting under the cent threshold. A residual that can never post would
    // prove far less: the interesting case is money the engine would act on.
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status,
                               detail, created_at, settled_at)
         VALUES (?, ?, 20000, 'https://rollup-other.test/x', 'settled', NULL, ?, ?)`,
      ).run(randomUUID(), otherAgent, `2099-03-0${i + 1}T00:00:00.000Z`, `2099-03-0${i + 1}T00:00:00.000Z`);
    }
    db.exec("COMMIT");

    const mine = computeBuckets(COMPANY);
    const theirs = computeBuckets(otherCompany);

    // 1. Neither company can see the other.
    assert(
      !mine.some((b) => b.agentName === otherName),
      "the first company's buckets do not contain the second company's agent",
    );
    assert(
      theirs.length > 0 && theirs.every((b) => b.agentName === otherName),
      "the second company's buckets contain only its own agent",
    );

    // 2. The partition is exact — no bucket dropped, none counted twice. The
    //    key is the one computeBuckets itself uses, so this compares like with
    //    like rather than approximating it.
    const keyOf = (b: { agentId: string; counterparty: string; ledgerClass: string }) =>
      JSON.stringify([b.agentId, b.counterparty, b.ledgerClass]);
    const union = new Set([...mine, ...theirs].map(keyOf));
    assertEqual(
      union.size,
      mine.length + theirs.length,
      "no bucket appears under both companies",
    );

    const everyCompany = (
      db.prepare("SELECT id FROM companies ORDER BY created_at").all() as unknown as {
        id: string;
      }[]
    ).map((r) => r.id);
    const assembled = everyCompany.flatMap((id) => computeBuckets(id));
    assertEqual(
      assembled.length,
      new Set(assembled.map(keyOf)).size,
      "assembling every company's buckets produces no duplicate",
    );
    assert(
      assembled.some((b) => b.agentName === otherName),
      "and the assembled set does include the second company — the partition loses nothing",
    );

    /*
     * 3. THE CHECKER ATTRIBUTES A PROBLEM TO THE RIGHT COMPANY.
     *
     *    Stronger than asserting both are clean, and it is what the first draft
     *    of this block got wrong: the second company has 60000 base units of
     *    postable money that no run has posted yet, so check 4 SHOULD report it.
     *    Asserting silence would have passed just as well against a checker that
     *    was still global, because a global checker reports the same single
     *    problem — it would simply have blamed it on everyone.
     *
     *    So: the second company owns the problem, and the first company — whose
     *    books the sections above already balanced — is clean despite that
     *    problem existing in the same database.
     */
    const minePre = verifyPostingIntegrity(COMPANY);
    const theirsPre = verifyPostingIntegrity(otherCompany);
    assertEqual(
      minePre.length,
      0,
      "the first company is clean even though the second has unposted money",
    );
    assertEqual(theirsPre.length, 1, "the second company reports exactly its own problem");
    assert(
      theirsPre[0]!.check === "nothing postable left unposted" &&
        theirsPre[0]!.detail.includes(otherName),
      "and the problem names the second company's own agent, not anyone else's",
    );

    /*
     * 4. EACH COMPANY'S RUN POSTS ITS OWN BOOKS AND NOTHING ELSE.
     *
     *    The first company runs first, and the second company's problem from
     *    step 3 must SURVIVE it: that is what proves the first run did not
     *    quietly post the second company's money. Then the second company's own
     *    run clears it.
     */
    const beforeRun = listPostingLines({ companyId: otherCompany }).length;
    runPosting(COMPANY);
    assertEqual(
      listPostingLines({ companyId: otherCompany }).length,
      beforeRun,
      "the first company's run leaves the second company's books untouched",
    );
    assertEqual(
      verifyPostingIntegrity(otherCompany).length,
      1,
      "so the second company still reports its own unposted money — nobody else posted it",
    );

    runPosting(otherCompany);
    const afterRun = listPostingLines({ companyId: otherCompany }).length;
    assert(
      afterRun > beforeRun,
      "the second company's own run posts its postable money",
    );
    assertEqual(
      listPostingLines({ companyId: COMPANY }).filter((l) => l.agentName === otherName).length,
      0,
      "and none of it lands under the first company",
    );
    /*
     * And conservation now holds for EACH company independently. This is the
     * assertion that fails if `owed` and `posted` are scoped inconsistently —
     * one side reading one company and the other reading all of them. Two
     * companies' errors could otherwise cancel and report clean, which is the
     * per-direction failure 0012 guards against, reintroduced on a new axis.
     */
    for (const [label, id] of [["first", COMPANY], ["second", otherCompany]] as const) {
      assertEqual(
        verifyPostingIntegrity(id).length,
        0,
        `conservation holds for the ${label} company on its own after a run`,
      );
    }
  }

  // --- database health ---
  const fkViolations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  assertEqual(fkViolations.length, 0, "no foreign key violations");
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  assertEqual(integrity.integrity_check, "ok", "sqlite integrity_check is ok");
}

async function main(): Promise<void> {
  verifyClearable();
  verifyAbsorption();
  verifyCentFormatting();
  verifyCsvAmounts();
  await verifyEngine();
  console.log(`\nAll ${checks} checks passed.`);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
