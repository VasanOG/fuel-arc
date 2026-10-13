/**
 * Seeds one day of synthetic agent spend so the QuickBooks walkthrough has
 * something to post.
 *
 * WHY THIS EXISTS. The live database's real payments are all dated 2026-08-02
 * and earlier, and their rollup lines are already committed to a draft. A demo
 * needs a clean, uncommitted day — and one that actually shows the thing worth
 * showing, which is not the total but the authorisation underneath it.
 *
 * WHAT IT IS NOT. These are records, not money. Nothing here touches Fireblocks,
 * signs anything, or moves a cent; it inserts rows describing payments that
 * already resolved. Every row is stamped `detail = 'demo-seed'` so synthetic
 * spend can always be told apart from the real thing, and re-running deletes
 * only rows carrying that stamp.
 *
 * It refuses to touch a day that already has posting lines, so it can never
 * disturb committed history.
 *
 * Run:  npx tsx scripts/seed-demo-day.ts [YYYY-MM-DD]
 */
import { randomUUID } from "node:crypto";
import { db } from "../src/db/index.js";

/** The marker that makes synthetic spend identifiable and removable. */
const DEMO_MARK = "demo-seed";

/** $0.001 — the characteristic size of an agent API call, and why rollup exists. */
const TENTH_OF_A_CENT = 1000;

interface Seed {
  agentName: string;
  vendorHost: string;
  path: string;
  /** Payments that settled cleanly. */
  settled: number;
  /** Signed but never confirmed — these land in suspense, not expenses. */
  unreconciled: number;
  /** How many of the settled ones a human had to approve first. */
  approvals: number;
  /** Which cap or check held it for a human. Constrained by the schema. */
  blockedScope: "team" | "company" | "anomaly";
}

/**
 * Three vendors, so the entry reads like a real day's spend rather than one
 * repeated call. Counts are multiples of ten so each bucket lands on a whole
 * cent: 10 x $0.001 = $0.01, which is the smallest amount that can be booked
 * at all.
 */
const SEEDS: Seed[] = [
  {
    agentName: "research-bot",
    vendorHost: "api.serpstack.test",
    path: "/v1/search",
    settled: 40,
    unreconciled: 0,
    approvals: 2,
    blockedScope: "team",
  },
  {
    agentName: "research-bot",
    vendorHost: "api.firecrawl.test",
    path: "/v1/scrape",
    settled: 30,
    unreconciled: 20,
    approvals: 1,
    blockedScope: "anomaly",
  },
  {
    agentName: "race-bot",
    vendorHost: "api.serpstack.test",
    path: "/v1/search",
    settled: 20,
    unreconciled: 0,
    approvals: 0,
    blockedScope: "team",
  },
];

function isoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Spreads timestamps across the working day so the trace does not look generated. */
function stampFor(day: string, index: number, total: number): string {
  const startMs = Date.parse(`${day}T09:00:00Z`);
  const spanMs = 8 * 60 * 60 * 1000;
  return new Date(startMs + Math.floor((spanMs * index) / Math.max(total, 1))).toISOString();
}

function main(): void {
  const day = process.argv[2] ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (!isoDay(day)) throw new Error(`Not a calendar day: ${day}`);

  const agents = new Map(
    (db.prepare("SELECT id, name FROM agents").all() as { id: string; name: string }[]).map((a) => [
      a.name,
      a.id,
    ]),
  );

  const insertPayment = db.prepare(
    `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at, settled_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const insertApproval = db.prepare(
    `INSERT INTO approval_requests (id, agent_id, amount_base_units, resource_url, blocked_scope, status, approval_expires_at, payment_id, created_at, decided_at, detail, is_demo)
     VALUES (?, ?, ?, ?, ?, 'approved', NULL, ?, ?, ?, ?, 1)`,
  );

  /*
   * Refuse to run at all without the marker column.
   *
   * Without is_demo this script has no safe way to clear a previous seed: the
   * only alternative predicate is the free-text one it was moved off, and
   * falling back to it silently would reintroduce exactly the deletion hazard
   * the column exists to close. Stop instead.
   */
  const paymentColumns = (
    db.prepare("PRAGMA table_info('payments')").all() as unknown as { name: string }[]
  ).map((c) => c.name);
  if (!paymentColumns.includes("is_demo")) {
    throw new Error(
      "payments.is_demo is missing. This database predates the demo marker; start the Fuel " +
        "server once to run migrations, then seed.",
    );
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // THE GUARD THAT PROTECTS COMMITTED HISTORY, and it lives inside the
    // transaction deliberately. Checking before BEGIN leaves a window where a
    // rollup run could create lines for this day between the check and the
    // write — narrow, but the whole point of this guard is that a demo is
    // never the reason a committed line changes, and "narrow" is not "closed".
    // BEGIN IMMEDIATE takes the write lock up front, so from here the answer
    // cannot change underneath us.
    const existingLines = db
      .prepare("SELECT COUNT(*) AS n FROM posting_lines WHERE posting_day = ?")
      .get(day) as { n: number };
    if (existingLines.n > 0) {
      throw new Error(
        `${day} already has ${existingLines.n} rollup line(s). Refusing to seed a day that has ` +
          `been rolled up — pick a day with no posting lines.`,
      );
    }

    /*
     * Idempotent: a re-run replaces the previous seed for this day and nothing
     * else.
     *
     * Scoped by is_demo, NOT by detail. The old predicate matched
     * `detail = 'demo-seed'`, and its comment claimed "a real payment can never
     * be caught by it". That was wrong. `payments.detail` is not ours on a
     * failure after signing: describeRejection in src/payments/pay.ts writes a
     * THIRD-PARTY MERCHANT's error string into it verbatim, so a merchant
     * answering {"error":"demo-seed"} could have a real payment deleted by a
     * demo re-seed. is_demo cannot be set by any production write path, which
     * is what makes this predicate safe rather than merely narrow.
     */
    const clearedApprovals = db
      .prepare(`DELETE FROM approval_requests WHERE is_demo = 1 AND created_at LIKE ?`)
      .run(`${day}%`);
    const clearedPayments = db
      .prepare(`DELETE FROM payments WHERE is_demo = 1 AND created_at LIKE ?`)
      .run(`${day}%`);

    let payments = 0;
    let approvals = 0;
    let settledUnits = 0;
    let unreconciledUnits = 0;

    for (const seed of SEEDS) {
      const agentId = agents.get(seed.agentName);
      if (!agentId) throw new Error(`No agent named "${seed.agentName}" exists in this database.`);

      const total = seed.settled + seed.unreconciled;
      for (let i = 0; i < total; i += 1) {
        const settled = i < seed.settled;
        const createdAt = stampFor(day, i, total);
        const paymentId = randomUUID();

        insertPayment.run(
          paymentId,
          agentId,
          TENTH_OF_A_CENT,
          `https://${seed.vendorHost}${seed.path}`,
          settled ? "settled" : "unreconciled",
          `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`,
          DEMO_MARK,
          createdAt,
          // An unreconciled payment is precisely one with no settlement time.
          settled ? new Date(Date.parse(createdAt) + 9_000).toISOString() : null,
        );
        payments += 1;
        if (settled) settledUnits += TENTH_OF_A_CENT;
        else unreconciledUnits += TENTH_OF_A_CENT;

        // The part a billing pipeline cannot reproduce: a human decided this
        // one before it was allowed to happen.
        if (settled && i < seed.approvals) {
          insertApproval.run(
            randomUUID(),
            agentId,
            TENTH_OF_A_CENT,
            `https://${seed.vendorHost}${seed.path}`,
            seed.blockedScope,
            paymentId,
            createdAt,
            new Date(Date.parse(createdAt) + 4_000).toISOString(),
            DEMO_MARK,
          );
          approvals += 1;
        }
      }
    }

    db.exec("COMMIT");

    const dollars = (units: number) => `$${(units / 1_000_000).toFixed(3)}`;
    console.log(`Seeded ${day}`);
    if (clearedPayments.changes > 0 || clearedApprovals.changes > 0) {
      console.log(
        `  replaced a previous seed: ${clearedPayments.changes} payment(s), ` +
          `${clearedApprovals.changes} approval(s)`,
      );
    }
    console.log(`  ${payments} payments across ${new Set(SEEDS.map((s) => s.vendorHost)).size} vendors`);
    console.log(`  settled      ${dollars(settledUnits)}  -> expense`);
    console.log(`  unreconciled ${dollars(unreconciledUnits)}  -> suspense`);
    console.log(`  ${approvals} required a human approval first`);
    console.log(`\nNext: POST /api/postings/run, then preview ${day}.`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

main();
