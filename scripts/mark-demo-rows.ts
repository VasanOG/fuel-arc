/**
 * Marks seeded demonstration rows as demo, deliberately and visibly.
 *
 * WHY THIS IS A SCRIPT AND NOT A MIGRATION.
 *
 * The obvious move was to backfill inside the migration:
 * `UPDATE payments SET is_demo = 1 WHERE detail = 'demo-seed'`. It is wrong,
 * and the reason is worth writing down.
 *
 * `payments.detail` is not ours. On a failure after signing, describeRejection
 * in src/payments/pay.ts writes JSON.parse(header).error straight from a
 * THIRD-PARTY MERCHANT's response into that column. A merchant answering
 * {"error":"demo-seed"} would therefore have a real payment silently relabelled
 * as demonstration data by a migration nobody watched run. Under the seed
 * script's old delete predicate it could also have had that payment DELETED.
 *
 * So the free-text read happens exactly once, in the open, where a person can
 * see what it matched before anything changes. It prints candidates and stops.
 * Nothing is written without --confirm.
 *
 * After this runs, `detail` is never consulted for this purpose again: is_demo
 * is the marker, and it is the only thing the seed script and the API read.
 *
 * Run:
 *   npx tsx scripts/mark-demo-rows.ts              # inspect, change nothing
 *   npx tsx scripts/mark-demo-rows.ts --confirm    # mark them
 */

import { db } from "../src/db/index.js";

const MARK = "demo-seed";
const confirm = process.argv.includes("--confirm");

interface Candidate {
  id: string;
  status: string;
  created_at: string;
  agent: string;
}

function candidates(table: string): Candidate[] {
  return db
    .prepare(
      `SELECT p.id, p.status, p.created_at, a.name AS agent
       FROM ${table} p JOIN agents a ON a.id = p.agent_id
       WHERE p.detail = ? AND p.is_demo = 0
       ORDER BY p.created_at`,
    )
    .all(MARK) as unknown as Candidate[];
}

function report(table: string, rows: Candidate[]): void {
  console.log(`\n${table}: ${rows.length} candidate(s) with detail = "${MARK}" and is_demo = 0`);
  if (rows.length === 0) return;

  const byDay = new Map<string, number>();
  const byStatus = new Map<string, number>();
  for (const row of rows) {
    byDay.set(row.created_at.slice(0, 10), (byDay.get(row.created_at.slice(0, 10)) ?? 0) + 1);
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
  }
  for (const [day, count] of [...byDay].sort()) console.log(`   ${day}  ${count}`);
  console.log(`   by status: ${[...byStatus].map(([s, c]) => `${s} ${c}`).join(", ")}`);
  // The audit trail. Every id that is about to change, printed before it does.
  console.log(`   ids: ${rows.map((r) => r.id).join(" ")}`);
}

function main(): void {
  const payments = candidates("payments");
  const approvals = candidates("approval_requests");

  report("payments", payments);
  report("approval_requests", approvals);

  const total = payments.length + approvals.length;
  if (total === 0) {
    console.log("\nNothing to mark.");
    return;
  }

  if (!confirm) {
    console.log(
      `\nNothing was changed. Read the ids above — a real payment can hold this` +
        `\ntext if a merchant chose it — then re-run with --confirm to mark them.`,
    );
    return;
  }

  // One transaction: either every row is marked or none is, so a crash cannot
  // leave half a demo dataset labelled.
  db.exec("BEGIN IMMEDIATE");
  try {
    const marked = db
      .prepare(`UPDATE payments SET is_demo = 1 WHERE detail = ? AND is_demo = 0`)
      .run(MARK);
    const markedApprovals = db
      .prepare(`UPDATE approval_requests SET is_demo = 1 WHERE detail = ? AND is_demo = 0`)
      .run(MARK);
    db.exec("COMMIT");
    console.log(
      `\nMarked ${marked.changes} payment(s) and ${markedApprovals.changes} approval(s) as demo.`,
    );
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

main();
