/**
 * Verifies the QuickBooks integration: the guards, the mapper, the snapshot
 * binding, idempotency, and corrections.
 *
 * SAFE BY CONSTRUCTION. Builds a test database in the temp directory
 * (scripts/lib/test-db.ts) and points FUEL_DB_PATH at it before anything
 * touching the database is imported. It never opens `fuel.db`, moves no funds,
 * and — importantly — MAKES NO
 * NETWORK CALLS. Everything here is the half of the integration that can be
 * proved without credentials, which is most of it: what gets sent, what is
 * refused, and what happens to the record either way.
 *
 * The half this cannot cover is Intuit actually accepting a document. That
 * needs a developer sandbox account and is the live walkthrough in
 * docs/roadmap.md.
 *
 * Run:  npm run verify-quickbooks
 */

import { randomBytes, randomUUID } from "node:crypto";

import { createTestDatabase } from "./lib/test-db.js";
import { encryptSecret, decryptSecret } from "../src/lib/secrets.js";
import { grantedRealm } from "../src/quickbooks/oauth.js";
import type { LedgerClass } from "../src/accounting/rollup.js";
import {
  assertSandboxUrl,
  correctionDocNumberFor,
  docNumberFor,
  QBO_API_ORIGIN,
} from "../src/quickbooks/config.js";
import {
  assertBalanced,
  buildJournalEntry,
  UnsupportedCurrencyError,
  type MappableLine,
} from "../src/quickbooks/journal.js";

/**
 * A throwaway key for this run, set before anything reads it.
 *
 * Deliberately generated here rather than taken from the environment: the
 * verification must not depend on a developer's real key being present, and it
 * must never encrypt test data with the key that protects live tokens.
 */
process.env.FUEL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");

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

function refuses(description: string, fn: () => unknown): void {
  checks += 1;
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`FAILED: ${description} was accepted but should have been refused`);
}

// ---------------------------------------------------------------------------
// 1. The sandbox guard
// ---------------------------------------------------------------------------

function verifySandboxGuard(): void {
  console.log("\n== sandbox guard: origin equality, never a prefix ==");

  assertSandboxUrl(`${QBO_API_ORIGIN}/v3/company/123/journalentry`);
  checks += 1;

  // The one that matters. `startsWith(QBO_API_ORIGIN)` accepts this, because it
  // is a different host that happens to begin with the right characters.
  refuses(
    "a host merely PREFIXED by the sandbox origin",
    () => assertSandboxUrl("https://sandbox-quickbooks.api.intuit.com.evil.test/v3/company/1/x"),
  );
  refuses("the production API host", () =>
    assertSandboxUrl("https://quickbooks.api.intuit.com/v3/company/1/journalentry"),
  );
  refuses("plain http against the sandbox host", () =>
    assertSandboxUrl("http://sandbox-quickbooks.api.intuit.com/v3/company/1/x"),
  );
  refuses("a sandbox origin embedded in someone else's path", () =>
    assertSandboxUrl("https://evil.test/https://sandbox-quickbooks.api.intuit.com"),
  );
  refuses("an unparseable url", () => assertSandboxUrl("not a url"));
  refuses("a userinfo trick", () =>
    assertSandboxUrl("https://sandbox-quickbooks.api.intuit.com@evil.test/v3/x"),
  );

  console.log("   production, prefix, scheme, embedded, malformed and userinfo all refused");
}

// ---------------------------------------------------------------------------
// 2. Token encryption
// ---------------------------------------------------------------------------

function verifyTokenEncryption(): void {
  console.log("\n== tokens at rest ==");

  const token = "eyJ.FAKE_REFRESH_TOKEN_MATERIAL.xyz";
  const a = encryptSecret(token);
  const b = encryptSecret(token);

  assertEqual(decryptSecret(a), token, "a token round-trips");
  assert(a !== b, "the same token encrypts differently each time (random IV)");
  assert(!a.includes("FAKE_REFRESH"), "ciphertext contains no plaintext");
  assert(a.startsWith("v1."), "stored form is versioned, so it can be migrated later");

  // GCM authenticates, so tampering is detected rather than decrypting to
  // something plausible that would then be sent to Intuit as a bearer token.
  refuses("a tampered ciphertext", () => decryptSecret(a.slice(0, -4) + "AAAA"));
  refuses("a malformed blob", () => decryptSecret("garbage"));
  refuses("an unknown version", () => decryptSecret(a.replace(/^v1\./, "v9.")));

  // The failure path must not leak the value it failed on — an error message is
  // the easiest way for a secret to reach a log file.
  let message = "";
  try {
    decryptSecret(a.slice(0, -4) + "AAAA");
  } catch (error) {
    message = (error as Error).message;
  }
  assert(!message.includes("FAKE"), "a decryption error names no secret material");

  console.log("   round-trip, unique IVs, tamper-evident, and errors leak nothing");
}

// ---------------------------------------------------------------------------
// 3. The mapper
// ---------------------------------------------------------------------------

const ACCOUNTS = {
  expenseAccountId: "63",
  suspenseAccountId: "91",
  contraAccountId: "35",
  revenueAccountId: "77",
};

function line(
  ledgerClass: LedgerClass,
  amountBaseUnits: bigint,
  extra: Partial<MappableLine> = {},
): MappableLine {
  return {
    id: `line-${ledgerClass}-${amountBaseUnits}`,
    ledgerClass,
    amountBaseUnits,
    sourceCount: 1,
    agentName: "research-bot",
    counterparty: "api.example",
    ...extra,
  };
}

function build(lines: MappableLine[]) {
  return buildJournalEntry({
    lines,
    accounts: ACCOUNTS,
    docNumber: "FUEL-000000000000",
    txnDate: "2026-08-25",
    fuelReference: "FUEL-000000000000",
  });
}

function verifyMapper(): void {
  console.log("\n== the journal entry mapper ==");

  // Ordinary spend.
  const spend = build([line("expense", 30_000n)]);
  assertEqual(spend.Line.length, 2, "spend produces an expense debit and a contra credit");
  assertEqual(spend.Line[0]!.JournalEntryLineDetail.PostingType, "Debit", "spend debits expenses");
  assertEqual(spend.Line[1]!.JournalEntryLineDetail.PostingType, "Credit", "and credits the contra");
  assertEqual(assertBalanced(spend).debits, 0.03, "balanced at three cents");

  // Mixed, with a reclassification credit.
  const mixed = build([line("expense", 30_000n), line("suspense", -20_000n)]);
  assertEqual(mixed.Line.length, 3, "a mixed entry has three lines");
  assertEqual(
    mixed.Line[1]!.JournalEntryLineDetail.PostingType,
    "Credit",
    "a negative amount becomes a Credit, not a negative Amount",
  );
  assert(
    mixed.Line.every((l) => l.Amount > 0),
    "every Amount is positive — QuickBooks carries direction in PostingType",
  );
  assertBalanced(mixed);
  checks += 1;

  // THE CASE THAT PROVES THE MODEL. A pure reclassification nets to zero, so no
  // contra line is emitted: money moving between two accounts does not touch
  // the funding account.
  const reclass = build([line("expense", 20_000n), line("suspense", -20_000n)]);
  assertEqual(reclass.Line.length, 2, "a pure reclassification emits exactly two lines");
  assert(
    !reclass.Line.some(
      (l) => l.JournalEntryLineDetail.AccountRef.value === ACCOUNTS.contraAccountId,
    ),
    "and NO contra line — the funding account is untouched by a reclassification",
  );
  assertEqual(assertBalanced(reclass).debits, 0.02, "and it still balances, at two cents");

  // ---- revenue: the earning side of the same model (0012) ----

  // Revenue is CREDIT-natural, so a positive revenue amount credits income and
  // the contra takes the opposite side — money arriving INTO the Fuel balance.
  // Under the old sign-driven directionFor this line would have been a Debit to
  // income, which balances and is exactly backwards.
  const earn = build([line("revenue", 40_000n)]);
  assertEqual(earn.Line.length, 2, "revenue produces an income line and a contra line");
  assertEqual(
    earn.Line[0]!.JournalEntryLineDetail.PostingType,
    "Credit",
    "revenue CREDITS income — direction comes from the class, not the sign",
  );
  assertEqual(
    earn.Line[0]!.JournalEntryLineDetail.AccountRef.value,
    ACCOUNTS.revenueAccountId,
    "and it posts to the income account",
  );
  assertEqual(
    earn.Line[1]!.JournalEntryLineDetail.PostingType,
    "Debit",
    "the contra is DEBITED — the Fuel balance went up",
  );
  assertEqual(
    earn.Line[1]!.Description,
    "Received into Fuel balance",
    "and says so, rather than claiming the balance funded something",
  );
  assertEqual(assertBalanced(earn).debits, 0.04, "balanced at four cents");

  // A negative revenue amount (an unwind) flips to the opposite side, the same
  // way a negative suspense amount does.
  const earnUnwind = build([line("revenue", -40_000n)]);
  assertEqual(
    earnUnwind.Line[0]!.JournalEntryLineDetail.PostingType,
    "Debit",
    "a negative revenue amount posts opposite its natural side",
  );
  assertBalanced(earnUnwind);
  checks += 1;

  // Spend and revenue together: the contra carries only the NET movement in the
  // Fuel balance, not the gross of either side.
  const both = build([line("expense", 30_000n), line("revenue", 10_000n)]);
  assertEqual(both.Line.length, 3, "spend plus revenue is expense, income, contra");
  const contra = both.Line.find(
    (l) => l.JournalEntryLineDetail.AccountRef.value === ACCOUNTS.contraAccountId,
  )!;
  assertEqual(contra.Amount, 0.02, "the contra is the NET two cents, not the gross three");
  assertEqual(
    contra.JournalEntryLineDetail.PostingType,
    "Credit",
    "credited, because spend still outweighed revenue",
  );
  assertEqual(assertBalanced(both).debits, 0.03, "and the entry balances");

  // Revenue exceeding spend flips the contra, which the old bare-sum net could
  // not express: it would have added a credit to a debit and got the sign wrong.
  const netEarn = build([line("expense", 10_000n), line("revenue", 30_000n)]);
  const netEarnContra = netEarn.Line.find(
    (l) => l.JournalEntryLineDetail.AccountRef.value === ACCOUNTS.contraAccountId,
  )!;
  assertEqual(
    netEarnContra.JournalEntryLineDetail.PostingType,
    "Debit",
    "when revenue outweighs spend the Fuel balance rises, so the contra is a Debit",
  );
  assertEqual(netEarnContra.Amount, 0.02, "again the net, two cents");
  assertBalanced(netEarn);
  checks += 1;

  // THE CASE THE OLD COMMENT GOT WRONG. Equal spend and revenue also nets to
  // zero and also emits no contra — but it is NOT a reclassification. Both
  // situations are correct; the old comment asserted the zero net MEANT a
  // reclassification, which stopped being true the moment revenue existed.
  const offset = build([line("expense", 20_000n), line("revenue", 20_000n)]);
  assertEqual(offset.Line.length, 2, "an offsetting day emits expense and income only");
  assert(
    !offset.Line.some((l) => l.JournalEntryLineDetail.AccountRef.value === ACCOUNTS.contraAccountId),
    "and no contra line — the Fuel balance did not move, though nothing was reclassified",
  );
  assertEqual(assertBalanced(offset).debits, 0.02, "and it balances");

  // Refusals.
  refuses("a non-USD line", () => build([line("expense", 30_000n, { currency: "EUR" })]));
  refuses("a sub-cent amount that would round to $0.00", () => build([line("expense", 1_000n)]));
  refuses("an entry with no lines", () => build([]));
  refuses("an entry whose debits and credits differ", () =>
    assertBalanced({
      ...build([line("expense", 30_000n)]),
      Line: [build([line("expense", 30_000n)]).Line[0]!],
    }),
  );

  // A payload that reached Intuit carrying chain identifiers would put them in
  // a customer's permanent accounting records. 0006 binds this integration.
  const serialised = JSON.stringify([spend, mixed, reclass]).toLowerCase();
  for (const term of [
    "0x",
    "usdc",
    "sepolia",
    "chain",
    "wallet",
    "token",
    "facilitator",
    "x402",
    "eip",
  ]) {
    assert(!serialised.includes(term), `no "${term}" reaches QuickBooks (docs/decisions/0006)`);
  }

  console.log("   directions, balance, the zero-net reclassification, refusals, no-crypto");
}

function verifyDocNumbers(): void {
  console.log("\n== document numbers ==");

  const A = "company-a";
  const B = "company-b";
  const a = docNumberFor(A, "spend:daily:2026-08-25");
  const b = docNumberFor(A, "spend:daily:2026-08-25");
  const c = docNumberFor(A, "spend:daily:2026-08-26");

  assertEqual(a, b, "deterministic — the same scope always produces the same number");
  assert(a !== c, "distinct per day");
  assert(a.length <= 21, `within QuickBooks' 21-character limit (is ${a.length})`);
  assert(/^FUEL-[0-9a-f]{12}$/.test(a), "recognisably ours");

  // THE CROSS-TENANT ADOPTION. Same scope, two companies: identical numbers
  // would let the duplicate-number handler adopt the other company's document.
  assert(
    docNumberFor(B, "spend:daily:2026-08-25") !== a,
    "two companies posting the same scope get different numbers",
  );

  // A reversed entry keeps its number in QuickBooks, so re-posting the same
  // scope must not collide with it.
  assert(
    docNumberFor(A, "spend:daily:2026-08-25#1") !== a,
    "a later generation of the same scope gets a distinct number",
  );
  assert(
    correctionDocNumberFor(A, a, 1) !== a &&
      correctionDocNumberFor(A, a, 2) !== correctionDocNumberFor(A, a, 1),
    "each correction gets its own distinct number",
  );
  // Numbers minted before 7A-1 carry no company, so a correction of one must
  // not depend on the original's number to separate tenants.
  const legacy = "FUEL-000000000000";
  assert(
    correctionDocNumberFor(A, legacy, 1) !== correctionDocNumberFor(B, legacy, 1),
    "and a correction of a pre-7A-1 number is company-specific too",
  );

  console.log("   deterministic, bounded, per company, and distinct across generations and corrections");
}

// ---------------------------------------------------------------------------
// 4. Drafts, idempotency and corrections, against the test database
// ---------------------------------------------------------------------------

async function verifyDrafts(): Promise<void> {
  const scratch = createTestDatabase("quickbooks");
  process.env.FUEL_DB_PATH = scratch;
  console.log(`\n== drafts and postings, against the test database ==`);

  const { runPosting, listPostingLines } = await import("../src/db/postings.js");
  const { markSettled } = await import("../src/db/payments.js");
  const { bootstrapCompany } = await import("../src/db/companies.js");
  const { saveConfig, getConnection } = await import("../src/db/qbo.js");
  const { preview, buildReversal } = await import("../src/quickbooks/posting.js");
  const {
    beginPosting,
    markPosted,
    eligibleLines,
    getDraftUnscoped,
    getPostingUnscoped,
    createDraft,
    draftReadiness,
    fingerprintFor,
    markPostingFailed,
    DocumentInFlightError,
  } = await import("../src/db/qbo-postings.js");
  const { db, DB_PATH } = await import("../src/db/index.js");
  // TD-2. The database this process actually opened is the one just built --
  // not `fuel.db`, which src/db/index.ts falls back to if anything imported it
  // before FUEL_DB_PATH was set.
  assertEqual(DB_PATH, scratch, "TD-2: this suite opened its test database, not fuel.db");

  const company = bootstrapCompany();
  // Currency verification is part of setup now, exactly as it is for a real
  // company: preview and post refuse until Fuel has read USD from QuickBooks.
  // Recorded here so these tests exercise the drafts, not the scope gate —
  // which has its own section below.
  saveConfig(company.id, {
    ...ACCOUNTS,
    // The books the test database is connected to: these ids are the ones
    // this section treats as read from them.
    accountsRealmId: getConnection(company.id)?.realmId ?? null,
    rollupGrain: "daily",
    accountingCurrency: "USD",
    currencySource: "quickbooks_preferences",
    currencyCheckedAt: new Date().toISOString(),
  });

  // MAKES ITS OWN DATA. This was `listPostingLines({})[0]!.postingDay` — the
  // first day with any line at all — which assumed that day still had
  // UNCOMMITTED lines. True until those lines were posted for real, at which
  // point every day in the then-copied database was committed and the section
  // failed as a broken test rather than a broken engine. Fourth time this
  // codebase has been bitten by a fact that was true when written.
  //
  // The durable fix is not a better search: it is not depending on the live
  // database's leftovers at all. The database is writable, so the test seeds
  // the spend it needs on a day nothing else uses, and is therefore correct
  // whatever state the rest of the database is in.
  const DAY = "2019-03-04";
  // THIS COMPANY'S agent, not "any agent". `SELECT id FROM agents LIMIT 1`
  // returned whichever id sorted first, which was this company's until a second
  // company's agent (the ADR 0019 QA account, 2026-09-27) sorted ahead of it.
  // Spend then landed on another company's agent while this section posted for
  // this one, and found nothing. Fifth time: a fact true when written.
  const seedAgent = (
    db
      .prepare(
        "SELECT a.id FROM agents a JOIN teams t ON t.id = a.team_id WHERE t.company_id = ? LIMIT 1",
      )
      .get(company.id) as { id: string } | undefined
  )?.id;
  assert(seedAgent !== undefined, "the test database has an agent to attribute spend to");
  if (seedAgent === undefined) throw new Error("unreachable: asserted above");
  const seedPayment = db.prepare(
    `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at, settled_at)
     VALUES (?, ?, 1000, 'https://verify.test/x', 'settled', ?, 'verify-drafts', ?, ?)`,
  );
  for (let i = 0; i < 40; i += 1) {
    const at = `${DAY}T10:00:0${i % 10}.000Z`;
    seedPayment.run(`verify-drafts-${i}`, seedAgent, `0xverify${i}`, at, at);
  }
  // AND A CENT OF UNCONFIRMED SPEND, so the day has a suspense line and the
  // settlement check below has a payment to settle. It used to look for one in
  // the copied database, found none on this seeded day, and skipped itself
  // without a word on every run: two checks that had never run while the
  // suite said "passed".
  const seedUnreconciled = db.prepare(
    `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, detail, created_at)
     VALUES (?, ?, 1000, 'https://verify.test/x', 'unreconciled', 'verify-drafts', ?)`,
  );
  for (let i = 0; i < 10; i += 1) {
    seedUnreconciled.run(`verify-drafts-unreconciled-${i}`, seedAgent, `${DAY}T11:00:0${i}.000Z`);
  }
  runPosting(company.id);
  const day = DAY;
  assert(
    eligibleLines({ companyId: company.id, direction: "spend", grain: "daily", postingDay: day, counterparty: null }).length > 0,
    "the seeded day produced uncommitted rollup lines",
  );

  const eligible = () => eligibleLines({ companyId: company.id, direction: "spend", grain: "daily", postingDay: day, counterparty: null }).length;

  // --- the snapshot ---
  const draft = preview(company.id, { direction: "spend", postingDay: day });
  assert(draft.lineIds.length > 0, "a preview freezes the lines it covers");
  assertEqual(draftReadiness(draft).ok, true, "a fresh draft is postable");
  assertEqual(
    preview(company.id, { direction: "spend", postingDay: day }).docNumber,
    draft.docNumber,
    "previewing twice before posting yields the same document number",
  );

  // Tampering with the stored payload is caught, because the promise of this
  // table is "what you reviewed is what gets sent".
  const tampered = preview(company.id, { direction: "spend", postingDay: day });
  const altered = JSON.parse(JSON.stringify(tampered.payload));
  altered.Line[0].Amount = 999.99;
  db.prepare("UPDATE qbo_posting_drafts SET payload_json = ? WHERE id = ?").run(
    JSON.stringify(altered),
    tampered.id,
  );
  assertEqual(
    draftReadiness(getDraftUnscoped(tampered.id)!).ok,
    false,
    "a payload that no longer matches its hash is refused",
  );

  // --- staleness: a new line ---
  const withNewLine = preview(company.id, { direction: "spend", postingDay: day });
  const sample = listPostingLines({ companyId: company.id })[0]!;
  db.prepare(
    `INSERT INTO posting_lines (id, run_id, agent_id, counterparty, posting_day, ledger_class, amount_base_units, created_at)
     VALUES ('verify-late-line', 'verify', ?, ?, ?, 'expense', 10000, ?)`,
  ).run(sample.agentId, sample.counterparty, day, new Date().toISOString());
  assertEqual(
    draftReadiness(getDraftUnscoped(withNewLine.id)!).ok,
    false,
    "a line appearing after a preview makes the draft stale",
  );
  db.prepare("DELETE FROM posting_lines WHERE id = 'verify-late-line'").run();

  // --- staleness: a settlement ---
  const beforeSettle = preview(company.id, { direction: "spend", postingDay: day });
  const unreconciled = db
    .prepare(
      `SELECT p.id FROM payments p
       JOIN export_postings ep ON ep.payment_id = p.id
       WHERE ep.line_id IN (${beforeSettle.lineIds.map(() => "?").join(",")})
         AND p.status = 'unreconciled' LIMIT 1`,
    )
    .all(...(beforeSettle.lineIds as never[])) as unknown as { id: string }[];
  // Asserted, not branched on: a check that quietly skips is a check nobody
  // knows is off.
  assert(unreconciled.length > 0, "the draft covers an unreconciled payment to settle");

  const fingerprintBefore = fingerprintFor(beforeSettle.lineIds);
  markSettled(unreconciled[0]!.id, `0x${"0".repeat(64)}`);
  assert(
    fingerprintFor(beforeSettle.lineIds) !== fingerprintBefore,
    "a settlement changes the source fingerprint",
  );
  assertEqual(
    draftReadiness(getDraftUnscoped(beforeSettle.id)!).ok,
    false,
    "and makes the draft stale — a line-id comparison alone would miss this",
  );
  console.log("   settlement-driven staleness exercised against an unreconciled payment");

  // --- idempotency ---
  const live = preview(company.id, { direction: "spend", postingDay: day });
  const first = beginPosting({ companyId: company.id, draft: live, realmId: live.realmId });
  const second = beginPosting({ companyId: company.id, draft: live, realmId: live.realmId });
  assertEqual(first.id, second.id, "a second attempt on one draft reuses the first");
  assertEqual(
    first.requestId,
    second.requestId,
    "and reuses its idempotency key, so Intuit replays rather than duplicating",
  );
  assertEqual(eligible(), 0, "a pending attempt holds its lines — fail closed");

  /*
   * ONE LIVE ATTEMPT PER NUMBER. A second draft carrying the same number is
   * refused at beginPosting, before any request exists. Built directly rather
   * than through preview: in one process post() cannot reach this (readiness
   * and the insert run with no await between them), so this is the database
   * backstop for a second process, exercised on its own terms.
   */
  const postingsCount = () =>
    Number((db.prepare("SELECT COUNT(*) AS n FROM qbo_postings").get() as { n: number }).n);
  const twinDraft = (docNumber: string) =>
    createDraft({
      companyId: company.id,
      direction: "spend",
      grain: "daily",
      postingDay: day,
      counterparty: null,
      docNumber,
      payload: live.payload,
      lineIds: [],
      realmId: live.realmId,
    });
  const beforeTwin = postingsCount();
  let inFlight: unknown = null;
  try {
    beginPosting({ companyId: company.id, draft: twinDraft(live.docNumber), realmId: live.realmId });
  } catch (error) {
    inFlight = error;
  }
  assert(
    inFlight instanceof DocumentInFlightError,
    "a second draft cannot open an attempt on a number another attempt holds",
  );
  assertEqual(postingsCount(), beforeTwin, "and no attempt row was written for it");

  // POSITIVE CONTROL, and the reason the index is partial: failed, then a
  // fresh attempt under the same number, is the ordinary retry path.
  const retryNumber = `FUEL-retry${randomUUID().slice(0, 7)}`;
  const failedOnce = beginPosting({ companyId: company.id, draft: twinDraft(retryNumber), realmId: live.realmId });
  markPostingFailed(failedOnce.id, "rejected by QuickBooks validation");
  const retried = beginPosting({ companyId: company.id, draft: twinDraft(retryNumber), realmId: live.realmId });
  assert(
    retried.id !== failedOnce.id && retried.status === "pending",
    "a failed attempt does not block a fresh attempt under the same number",
  );
  markPostingFailed(retried.id, "test cleanup");

  markPosted({
    postingId: first.id,
    qboEntityId: "9001",
    qboSyncToken: "0",
    payload: live.payload,
  });
  const posted = getPostingUnscoped(first.id)!;
  assertEqual(getDraftUnscoped(live.id)!.status, "posted", "posting marks the draft posted");
  assertEqual(
    JSON.stringify(posted.postedPayload),
    JSON.stringify(live.payload),
    "the payload actually sent is stored for audit",
  );
  assert(posted.postedPayloadHash !== null, "along with its hash");
  assertEqual(eligible(), 0, "posted lines are no longer eligible — no double posting");
  assertEqual(
    draftReadiness(getDraftUnscoped(live.id)!).ok,
    false,
    "and a posted draft cannot be posted again",
  );

  // --- corrections ---
  const reversal = buildReversal(posted);
  assert(reversal.DocNumber !== posted.docNumber, "a correction gets its own document number");
  assert(
    reversal.PrivateNote.includes(posted.docNumber),
    "and names the entry it reverses, so the link is legible inside QuickBooks",
  );
  assert(
    reversal.Line.every(
      (l, i) =>
        l.JournalEntryLineDetail.PostingType !==
        posted.postedPayload!.Line[i]!.JournalEntryLineDetail.PostingType,
    ),
    "every direction is flipped",
  );
  assertBalanced(reversal);
  checks += 1;

  const reversalAttempt = beginPosting({
    companyId: company.id,
    draft: createDraft({
      companyId: company.id,
      direction: "spend",
      grain: "daily",
      postingDay: reversal.TxnDate,
      counterparty: null,
      docNumber: reversal.DocNumber,
      payload: reversal,
      lineIds: live.lineIds,
      realmId: posted.realmId,
    }),
    correctsPostingId: posted.id,
    realmId: posted.realmId,
  });
  assertEqual(eligible(), 0, "an unconfirmed reversal releases nothing");

  markPosted({
    postingId: reversalAttempt.id,
    qboEntityId: "9002",
    qboSyncToken: "0",
    payload: reversal,
  });
  assertEqual(
    eligible(),
    live.lineIds.length,
    "a POSTED reversal releases its lines, so the spend can be booked correctly",
  );
  assertEqual(
    getPostingUnscoped(reversalAttempt.id)!.correctsPostingId,
    posted.id,
    "and the correction is linked to the original",
  );

  const rebooked = preview(company.id, { direction: "spend", postingDay: day });
  assert(
    rebooked.docNumber !== posted.docNumber && rebooked.docNumber !== reversal.DocNumber,
    "re-booking after a reversal gets a fresh number — the reversed entry still holds the old one",
  );

  // A correction must be a NEW document, never a rewrite of the original. The
  // original's QuickBooks id and stored payload are unchanged by the reversal.
  const originalAfter = getPostingUnscoped(posted.id)!;
  assertEqual(originalAfter.qboEntityId, "9001", "the original keeps its QuickBooks id");
  assertEqual(
    JSON.stringify(originalAfter.postedPayload),
    JSON.stringify(live.payload),
    "and its stored payload is untouched — a correction never edits what was posted",
  );
  assertEqual(originalAfter.status, "posted", "the original is still posted, not voided");

  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  assertEqual(violations.length, 0, "no foreign key violations");
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  assertEqual(integrity.integrity_check, "ok", "sqlite integrity_check is ok");
}


// ---------------------------------------------------------------------------
// 6. The company profile: the exact request shapes
// ---------------------------------------------------------------------------

/**
 * Regression test for a live failure.
 *
 * `SELECT CompanyName, Country FROM CompanyInfo` was rejected by Intuit with
 * "Property CompanyName not found for Entity CompanyInfo — Invalid query".
 * That entity supports no projection at all; only `SELECT *` parses, so the
 * read endpoint is used instead.
 *
 * Behind that was a worse bug: the function was named and documented as a USD
 * check, but read `Country` and never looked at a currency — and the home
 * currency is not on CompanyInfo in the first place. So this asserts the shape
 * of BOTH requests, not just that the call succeeds; a mock that accepts
 * anything would have let the original code pass.
 */
async function verifyCompanyProfile(): Promise<void> {
  console.log("\n== company profile: request shapes and the USD refusal ==");

  const { bootstrapCompany } = await import("../src/db/companies.js");
  const { saveConnection, saveConfig, getConfig } = await import("../src/db/qbo.js");
  const { companyProfile, assertPostableCurrency } = await import("../src/quickbooks/accounts.js");
  const { UnsupportedCurrencyError: CurrencyError } = await import("../src/quickbooks/journal.js");

  const companyId = bootstrapCompany().id;
  const realmId = "4620816365257240000";

  // The connection in the test database is encrypted under another key and
  // deliberately cannot be read here. This one is readable under this run's
  // throwaway key, and its tokens are obvious fakes.
  saveConnection({
    companyId,
    realmId,
    accessToken: "not-a-real-access-token",
    accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: "not-a-real-refresh-token",
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  // The company now points at this section's fixture books, and every section
  // after this one previews against them. The account ids set earlier are this
  // suite's fixtures, so they move with it -- declared, as saveConfig requires,
  // rather than left stamped with the test database's books, which preview
  // would (rightly) refuse since 7A-3.
  const fixture = getConfig(companyId);
  saveConfig(companyId, {
    expenseAccountId: fixture.expenseAccountId,
    suspenseAccountId: fixture.suspenseAccountId,
    contraAccountId: fixture.contraAccountId,
    revenueAccountId: fixture.revenueAccountId,
    accountsRealmId: realmId,
  });

  const realFetch = globalThis.fetch;
  let requested: string[] = [];

  const stub = (homeCurrency: string | null, multiCurrency = false) => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      const body = new URL(url).pathname.endsWith("/query")
        ? {
            QueryResponse: {
              Preferences: [
                {
                  CurrencyPrefs: {
                    ...(homeCurrency === null ? {} : { HomeCurrency: { value: homeCurrency } }),
                    MultiCurrencyEnabled: multiCurrency,
                  },
                },
              ],
            },
          }
        : { CompanyInfo: { CompanyName: "Sandbox Company US 015d", Country: "US" } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  };

  try {
    requested = [];
    stub("USD");
    const profile = await companyProfile(companyId);

    assertEqual(requested.length, 2, "companyProfile makes exactly two requests");

    const infoUrl = new URL(requested[0]!);
    const prefsUrl = new URL(requested[1]!);

    // 1. CompanyInfo by its READ endpoint, addressed by realm — not /query.
    assertEqual(
      infoUrl.pathname,
      `/v3/company/${realmId}/companyinfo/${realmId}`,
      "CompanyInfo is fetched from the read endpoint, addressed by realm id",
    );
    assert(!infoUrl.searchParams.has("query"), "the CompanyInfo request carries no query parameter");

    // 2. THE REGRESSION. No outgoing statement may project columns out of
    //    CompanyInfo — the exact thing Intuit rejected.
    for (const url of requested) {
      const statement = new URL(url).searchParams.get("query") ?? "";
      assert(
        !/\bFROM\s+CompanyInfo\b/i.test(statement),
        `no request queries CompanyInfo with a statement (got: ${statement || "none"})`,
      );
    }

    // 3. Home currency comes from Preferences, which does support SELECT *.
    assertEqual(prefsUrl.pathname, `/v3/company/${realmId}/query`, "Preferences is read by query");
    assertEqual(
      prefsUrl.searchParams.get("query"),
      "SELECT * FROM Preferences",
      "the Preferences statement is exactly SELECT * FROM Preferences",
    );

    assertEqual(profile.name, "Sandbox Company US 015d", "company name is parsed from CompanyInfo");
    assertEqual(profile.country, "US", "country is parsed from CompanyInfo");
    assertEqual(profile.homeCurrency, "USD", "home currency is parsed from Preferences");
    assertEqual(profile.multiCurrencyEnabled, false, "multi-currency flag is parsed");

    assertPostableCurrency(profile);
    checks += 1;

    // A US company keeping its books in another currency: the case the old
    // `Country` check would have waved straight through.
    requested = [];
    stub("CAD");
    const canadianBooks = await companyProfile(companyId);
    assertEqual(canadianBooks.country, "US", "country is still US");
    refuses("a company whose books are in CAD", () => assertPostableCurrency(canadianBooks));

    // Fail closed: an absent currency is not evidence of USD.
    requested = [];
    stub(null);
    const silent = await companyProfile(companyId);
    assertEqual(silent.homeCurrency, null, "an unreported home currency reads as null");
    refuses("a company reporting no home currency at all", () => assertPostableCurrency(silent));

    // Multi-currency enabled but books still in USD is postable, not refused.
    requested = [];
    stub("USD", true);
    const multi = await companyProfile(companyId);
    assertEqual(multi.multiCurrencyEnabled, true, "multi-currency enabled is reported");
    assertPostableCurrency(multi);
    checks += 1;

    // The refusal is the same error type the API maps to 422.
    let raised: unknown = null;
    try {
      assertPostableCurrency(canadianBooks);
    } catch (error) {
      raised = error;
    }
    assert(raised instanceof CurrencyError, "the refusal is an UnsupportedCurrencyError");
    assert(
      !String((raised as Error).message).includes("not-a-real"),
      "the refusal message carries no token material",
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("   read endpoint used, no CompanyInfo projection, USD enforced, fails closed");
}

// ---------------------------------------------------------------------------
// 7. Account specs fit inside QuickBooks' field limits
// ---------------------------------------------------------------------------

/**
 * Regression test for a live failure.
 *
 * The suspense description was 106 characters against a 100-character cap, and
 * Intuit reported it as error 2050 with `Supplied length:{2}` — an
 * unsubstituted placeholder naming neither the field nor the length. Worse, it
 * surfaced only after the expense account had already been created in the
 * customer's chart of accounts.
 */
async function verifyAccountSpecs(): Promise<void> {
  console.log("\n== account specs fit QuickBooks' field limits ==");

  const { REQUIRED_ACCOUNTS, assertAccountSpecsPostable } = await import(
    "../src/quickbooks/accounts.js"
  );

  assertAccountSpecsPostable();
  checks += 1;

  for (const [role, spec] of Object.entries(REQUIRED_ACCOUNTS)) {
    assert(
      spec.name.length >= 1 && spec.name.length <= 100,
      `the ${role} account name is 1-100 characters (${spec.name.length})`,
    );
    assert(
      spec.description.length >= 1 && spec.description.length <= 100,
      `the ${role} account description is 1-100 characters (${spec.description.length})`,
    );
  }

  console.log(
    `   ${Object.keys(REQUIRED_ACCOUNTS).length} specs checked before any request is made`,
  );
}

// ---------------------------------------------------------------------------
// 8. An empty preview says WHICH kind of empty it is
// ---------------------------------------------------------------------------

/**
 * Regression test for a misleading diagnostic.
 *
 * `NothingToPostError` used to assert "every line for that scope is already
 * committed" for any empty result, including a day that simply had no lines.
 * An operator previewing an untouched day was told their work was already
 * booked and went looking for a posting that did not exist.
 */
async function verifyEmptyPreviewDiagnostics(): Promise<void> {
  console.log("\n== an empty preview names its cause ==");

  const { preview } = await import("../src/quickbooks/posting.js");
  const { bootstrapCompany } = await import("../src/db/companies.js");
  const companyId = bootstrapCompany().id;

  // A day far outside anything the test database contains.
  let noLines: Error | null = null;
  try {
    preview(companyId, { direction: "spend", postingDay: "1999-01-04" });
  } catch (error) {
    noLines = error as Error;
  }

  assert(noLines !== null, "a day with no lines is refused");
  assert(
    /no rollup lines exist/i.test(noLines!.message),
    `an empty day says no lines exist (got: ${noLines?.message})`,
  );
  assert(
    !/already committed/i.test(noLines!.message),
    "an empty day does NOT claim its lines are already committed",
  );

  console.log("   'no lines' and 'already committed' are no longer the same sentence");
}

// ---------------------------------------------------------------------------
// 9. The USD-only scope gate
// ---------------------------------------------------------------------------

/**
 * Slice 2c. Fuel must never treat another currency as USD, and must never say
 * "verified" about something it only assumed.
 *
 * The bug this guards against was not a crash — it was a FALSE CLAIM. ADR 0008
 * said USD was enforced twice; the setup-time half read `Country`, which is not
 * evidence of a company's accounting currency, so a US-registered company
 * keeping its books in CAD would have passed and had every figure mis-stated at
 * par. The tests below assert the shape of the claim, not just the outcome.
 */
async function verifyCurrencyScope(): Promise<void> {
  console.log("\n== USD-only scope: verified, never inferred ==");

  const { getConfig, saveConfig, currencyBlocker } = await import("../src/db/qbo.js");
  const { bootstrapCompany } = await import("../src/db/companies.js");
  const { preview, post, CurrencyScopeError } = await import("../src/quickbooks/posting.js");
  const companyId = bootstrapCompany().id;

  const { listPostingLines } = await import("../src/db/postings.js");
  const { eligibleLines } = await import("../src/db/qbo-postings.js");

  // Not a hardcoded date. The sections above post some of these lines, so which
  // days still have uncommitted ones depends on what ran first — asking is
  // correct where assuming was merely convenient.
  const day = [...new Set(listPostingLines({ companyId }).map((l) => l.postingDay))]
    .sort()
    .find((d) => eligibleLines({ companyId: companyId, direction: "spend", grain: "daily", postingDay: d, counterparty: null }).length > 0);
  assert(day !== undefined, "a day with uncommitted lines exists to test the gate against");

  const restore = getConfig(companyId);

  const setCurrency = (currency: string | null, source: "quickbooks_preferences" | null) =>
    saveConfig(companyId, {
      accountingCurrency: currency,
      currencySource: source,
      currencyCheckedAt: currency === null ? null : new Date().toISOString(),
    });

  try {
    // --- unverified blocks preview -------------------------------------
    setCurrency(null, null);
    assert(currencyBlocker(getConfig(companyId)) !== null, "an unverified company is blocked");
    refuses("preview on a company whose currency was never verified", () =>
      preview(companyId, { direction: "spend", postingDay: day! }),
    );

    // --- non-USD blocks preview ----------------------------------------
    setCurrency("CAD", "quickbooks_preferences");
    const cadBlocker = currencyBlocker(getConfig(companyId));
    assert(cadBlocker !== null, "a CAD company is blocked");
    assert(
      /CAD/.test(cadBlocker!) && /USD-only/.test(cadBlocker!),
      `the refusal names the currency and the scope (got: ${cadBlocker})`,
    );
    refuses("preview on a CAD company", () => preview(companyId, { direction: "spend", postingDay: day! }));

    // --- NO COUNTRY INFERENCE. The heart of Slice 2c ---------------------
    // A US company keeping books in CAD stays blocked. Nothing in the gate may
    // consult a country, so there is no value of country that unblocks this.
    const { companyProfile } = await import("../src/quickbooks/accounts.js");
    const gateSource = currencyBlocker.toString() + companyProfile.toString();
    assert(
      !/\bCountry\b/.test(currencyBlocker.toString()),
      "the currency gate never reads a country",
    );
    assert(
      !/country/i.test(
        JSON.stringify({
          currency: getConfig(companyId).accountingCurrency,
          source: getConfig(companyId).currencySource,
        }),
      ),
      "the recorded currency evidence carries no country",
    );
    assert(
      /Preferences/.test(gateSource),
      "the currency is read from QuickBooks Preferences, the documented home-currency source",
    );

    // --- a weaker source is not evidence --------------------------------
    // The gate must reject it rather than trust whatever the column holds.
    //
    // THIS USED TO WRITE THE VALUE STRAIGHT TO THE ROW, bypassing saveConfig's
    // typing. It cannot any more: 6B-1's qbo_config rebuild applies the
    // currency_source CHECK for the first time, so 'operator_guess' is no
    // longer a value the column will accept on ANY database. That is a
    // tightening, not a loss — the constraint was declared in the DDL from the
    // start and had simply never reached a migrated table, because ALTER TABLE
    // ADD COLUMN cannot carry one.
    //
    // The gate is still what is being tested, and it is still tested against a
    // value the database would refuse: the point was never that such a row
    // exists, it was that currencyBlocker does not trust the column. Handing it
    // the config object directly proves exactly that, and proves it for values
    // the storage layer now makes impossible.
    const weak = currencyBlocker({
      ...getConfig(companyId),
      accountingCurrency: "USD",
      currencySource: "operator_guess" as never,
    });
    assert(weak !== null, "USD from a non-QuickBooks source is still refused");
    assert(/not evidence/.test(weak!), `the refusal says it is not evidence (got: ${weak})`);

    // --- verified USD passes, and the walkthrough still works ------------
    setCurrency("USD", "quickbooks_preferences");
    assertEqual(currencyBlocker(getConfig(companyId)), null, "verified USD is not blocked");

    const draft = preview(companyId, { direction: "spend", postingDay: day! });
    assert(draft.lineIds.length > 0, "a verified USD company can still preview");
    assertEqual(draft.payload.CurrencyRef.value, "USD", "the document is still USD");

    // --- post is gated too, not just preview ----------------------------
    // A draft frozen while in scope must not post once the company is not.
    //
    // Slice 2d changed HOW post decides: it no longer trusts the stored record
    // at all, it re-reads Preferences first. So the stub below is not scaffolding
    // around the assertion — it IS the thing being asserted, and section 10
    // covers the freshness mechanism properly, including what is not sent.
    setCurrency("CAD", "quickbooks_preferences");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const body = new URL(String(input)).pathname.endsWith("/query")
        ? { QueryResponse: { Preferences: [{ CurrencyPrefs: { HomeCurrency: { value: "CAD" } } }] } }
        : { CompanyInfo: { CompanyName: "Scratch Co", Country: "US" } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let postError: unknown = null;
    try {
      await post(companyId, draft);
    } catch (error) {
      postError = error;
    } finally {
      globalThis.fetch = realFetch;
    }
    assert(
      postError instanceof CurrencyScopeError,
      "a draft built in scope cannot post after the company leaves scope",
    );

    // --- and none of this touched the draft -----------------------------
    const { getDraftUnscoped } = await import("../src/db/qbo-postings.js");
    const stored = getDraftUnscoped(draft.id)!;
    assertEqual(stored.payloadHash, draft.payloadHash, "the gate did not alter the frozen draft");
    assertEqual(stored.status, "previewed", "a refused post leaves the draft previewed");
  } finally {
    saveConfig(companyId, {
      accountingCurrency: restore.accountingCurrency,
      currencySource: restore.currencySource,
      currencyCheckedAt: restore.currencyCheckedAt,
    });
  }

  console.log("   unverified, non-USD and weak-source all blocked; no country inference");
}

// ---------------------------------------------------------------------------
// 10. Currency freshness at post time
// ---------------------------------------------------------------------------

/**
 * Slice 2d. The stored verification preview gates on is a fact with a
 * timestamp, and facts about someone else's system go stale.
 *
 * These tests assert what was NOT sent as much as what was. A refused post must
 * be indistinguishable from a post that never happened: no attempt row, no
 * requestid, no JournalEntry. Counting the outgoing requests is the only way to
 * know that, because a function that returns an error having already sent
 * something looks identical from the outside.
 */
async function verifyPostTimeFreshness(): Promise<void> {
  console.log("\n== currency freshness at post time ==");

  const { getConfig, saveConfig, saveConnection } = await import("../src/db/qbo.js");
  const { bootstrapCompany } = await import("../src/db/companies.js");
  const { preview, post, CurrencyScopeError } = await import("../src/quickbooks/posting.js");
  const { listPostingLines } = await import("../src/db/postings.js");
  const { eligibleLines, getDraftUnscoped } = await import("../src/db/qbo-postings.js");
  const { db } = await import("../src/db/index.js");

  const companyId = bootstrapCompany().id;
  const realmId = "4620816365257240000";
  saveConnection({
    companyId,
    realmId,
    accessToken: "not-a-real-access-token",
    accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: "not-a-real-refresh-token",
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  const day = [...new Set(listPostingLines({ companyId }).map((l) => l.postingDay))]
    .sort()
    .find((d) => eligibleLines({ companyId: companyId, direction: "spend", grain: "daily", postingDay: d, counterparty: null }).length > 0);
  assert(day !== undefined, "a day with uncommitted lines exists for the freshness test");

  const asVerifiedUsd = () =>
    saveConfig(companyId, {
      accountingCurrency: "USD",
      currencySource: "quickbooks_preferences",
      // Deliberately old. This is the stale record the fresh check must not trust.
      currencyCheckedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    });

  const realFetch = globalThis.fetch;
  let sent: { method: string; path: string }[] = [];

  /** Routes by path; `homeCurrency` is what Preferences will claim this time. */
  const stub = (homeCurrency: string | null) => {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      sent.push({ method, path: url.pathname });

      if (url.pathname.endsWith("/query")) {
        return new Response(
          JSON.stringify({
            QueryResponse: {
              Preferences: [
                {
                  CurrencyPrefs: {
                    ...(homeCurrency === null ? {} : { HomeCurrency: { value: homeCurrency } }),
                    MultiCurrencyEnabled: false,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/companyinfo/" + realmId)) {
        return new Response(
          JSON.stringify({ CompanyInfo: { CompanyName: "Scratch Co", Country: "US" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/journalentry")) {
        return new Response(
          JSON.stringify({ JournalEntry: { Id: "9001", SyncToken: "0" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  };

  const journalEntryWrites = () =>
    sent.filter((r) => r.method === "POST" && r.path.endsWith("/journalentry")).length;

  const attemptCount = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM qbo_postings").get() as { n: number }).n;

  try {
    // --- PREVIEW SENDS NOTHING ------------------------------------------
    asVerifiedUsd();
    sent = [];
    stub("USD");
    const draft = preview(companyId, { direction: "spend", postingDay: day! });
    assertEqual(sent.length, 0, "preview sends ZERO QuickBooks requests");
    assert(draft.lineIds.length > 0, "preview still produced a draft");

    // --- STALE USD + FRESH NON-USD REFUSES ------------------------------
    // The record still says USD, verified 90 days ago. QuickBooks now says CAD.
    asVerifiedUsd();
    assertEqual(getConfig(companyId).accountingCurrency, "USD", "the stored record still says USD");

    const attemptsBefore = attemptCount();
    sent = [];
    stub("CAD");
    let refusal: unknown = null;
    try {
      await post(companyId, draft);
    } catch (error) {
      refusal = error;
    }
    assert(refusal instanceof CurrencyScopeError, "a stale USD record does not survive a fresh CAD reading");
    assert(/CAD/.test((refusal as Error).message), "the refusal names the currency actually found");

    // The three things that must NOT have happened.
    assertEqual(journalEntryWrites(), 0, "the refused post sent ZERO JournalEntry mutations");
    assertEqual(attemptCount(), attemptsBefore, "the refused post created no qbo_posting attempt");
    assert(
      sent.every((r) => r.method === "GET"),
      "the refused post made only reads, never a mutation",
    );

    // And the reading was recorded, so status stops claiming a stale USD.
    assertEqual(getConfig(companyId).accountingCurrency, "CAD", "the fresh reading was recorded");

    // --- UNKNOWN CURRENCY ALSO REFUSES ----------------------------------
    asVerifiedUsd();
    sent = [];
    stub(null);
    let unknownRefusal: unknown = null;
    try {
      await post(companyId, draft);
    } catch (error) {
      unknownRefusal = error;
    }
    assert(unknownRefusal instanceof CurrencyScopeError, "an unreported currency refuses the post");
    assertEqual(journalEntryWrites(), 0, "the unknown-currency refusal sent no JournalEntry");
    assertEqual(getConfig(companyId).accountingCurrency, null, "an unreported currency is recorded as null");

    // --- THE SNAPSHOT SURVIVED BOTH REFUSALS ----------------------------
    const stored = getDraftUnscoped(draft.id)!;
    assertEqual(stored.payloadHash, draft.payloadHash, "the frozen payload is unchanged");
    assertEqual(stored.status, "previewed", "a refused post leaves the draft previewed");

    // --- FRESH USD STILL POSTS ------------------------------------------
    asVerifiedUsd();
    sent = [];
    stub("USD");
    const posted = await post(companyId, draft);
    assertEqual(posted.status, "posted", "a fresh USD reading lets the post proceed");
    assertEqual(posted.qboEntityId, "9001", "the document id came back");
    assertEqual(journalEntryWrites(), 1, "exactly one JournalEntry mutation was sent");
    assertEqual(
      getConfig(companyId).currencySource,
      "quickbooks_preferences",
      "the record is re-established from Preferences",
    );

    // --- AND THE EXACT STORED BYTES WERE SENT ---------------------------
    const postedDraft = getDraftUnscoped(draft.id)!;
    assertEqual(
      posted.postedPayloadHash,
      postedDraft.payloadHash,
      "the bytes posted are the bytes reviewed — the freshness check did not recompute",
    );

    // --- IDEMPOTENCY UNCHANGED ------------------------------------------
    sent = [];
    stub("USD");
    let retry: unknown = null;
    try {
      await post(companyId, draft);
    } catch (error) {
      retry = error;
    }
    assert(retry !== null, "re-posting a posted draft is still refused");
    assertEqual(journalEntryWrites(), 0, "the retry sent no second JournalEntry");
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("   preview silent; stale USD refused on a fresh reading; zero writes on refusal");
}

/**
 * Spend and revenue as two documents that cannot contaminate each other.
 *
 * Everything here is new ground: before 6B-1 no revenue line could exist, so
 * every one of these paths has been carrying an assumption nobody could test.
 */
async function verifyDirection(): Promise<void> {
  console.log("\n== direction: two documents, and no way to mix them ==");

  // THE DRAFTS SECTION'S DATABASE, not a new one. src/db/index.ts opens
  // FUEL_DB_PATH once, at the first import, so a second path set here would
  // never be read. This section used to copy fuel.db again anyway; the copy
  // was made and never opened.
  const { db } = await import("../src/db/index.js");
  const { bootstrapCompany } = await import("../src/db/companies.js");
  const { saveConfig, saveConnection } = await import("../src/db/qbo.js");
  const { preview, buildReversal } = await import("../src/quickbooks/posting.js");
  const { eligibleLines, fingerprintFor, createDraft, draftReadiness } = await import(
    "../src/db/qbo-postings.js"
  );
  const { runPosting } = await import("../src/db/postings.js");

  const company = bootstrapCompany();
  saveConnection({
    companyId: company.id,
    realmId: "direction-realm",
    accessToken: "a",
    refreshToken: "r",
    accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  saveConfig(company.id, {
    expenseAccountId: "63",
    suspenseAccountId: "91",
    contraAccountId: "35",
    revenueAccountId: "77",
    accountsRealmId: "direction-realm",
    contraAccountKind: "prepaid_asset",
    rollupGrain: "daily",
    accountingCurrency: "USD",
    currencySource: "quickbooks_preferences",
    currencyCheckedAt: new Date().toISOString(),
  });

  // One day carrying BOTH directions, which is the only arrangement that can
  // demonstrate they stay apart.
  const DAY = "2019-05-06";
  // Scoped to this company for the reason the drafts section above records.
  const agentId = (
    db
      .prepare("SELECT a.id FROM agents a JOIN teams t ON t.id = a.team_id WHERE t.company_id = ? LIMIT 1")
      .get(company.id) as { id: string }
  ).id;
  for (let i = 0; i < 40; i += 1) {
    const at = `${DAY}T10:00:0${i % 10}.000Z`;
    db.prepare(
      `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at, settled_at)
       VALUES (?, ?, 1000, 'https://direction.test/x', 'settled', ?, 'dir', ?, ?)`,
    ).run(`dir-pay-${i}`, agentId, `0xdir${i}`, at, at);
  }
  const { registerEndpoint } = await import("../src/db/earning-endpoints.js");
  const endpoint = registerEndpoint({
    agentId,
    originUrl: "https://direction.test/earn",
    priceBaseUnits: 5000n,
    label: "Direction API",
  }).endpoint;
  for (let i = 0; i < 8; i += 1) {
    const at = `${DAY}T11:00:0${i % 10}.000Z`;
    db.prepare(
      `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status,
                             payer_address, authorization_nonce, tx_hash, created_at, settled_at)
       VALUES (?, ?, ?, 5000, 'settled', ?, ?, ?, ?, ?)`,
    ).run(`dir-rec-${i}`, agentId, endpoint.id, `0xp${i}`, `0xn${i}`, `0x${"c".repeat(64)}`, at, at);
  }
  runPosting(company.id);

  const spendLines = eligibleLines({ companyId: company.id, direction: "spend", grain: "daily", postingDay: DAY });
  const earnLines = eligibleLines({ companyId: company.id, direction: "earn", grain: "daily", postingDay: DAY });
  assert(spendLines.length > 0, "the day produced spend lines");
  assert(earnLines.length > 0, "and revenue lines");
  assert(
    spendLines.every((id) => !earnLines.includes(id)),
    "no line is eligible for both directions — this is what 0012 says would otherwise sweep " +
      "revenue into a spend draft on the first run",
  );

  // REVIEW: claim 4's contingency. The claim that no mixed-direction document
  // can be built holds ONLY while this parameter is required and throws. An
  // optional one falling through to "no filter" would falsify it silently, and
  // every test above would still pass.
  refuses("eligibleLines with no direction at all", () =>
    eligibleLines({ grain: "daily", postingDay: DAY } as never),
  );
  refuses("eligibleLines with a direction that is not one", () =>
    eligibleLines({ companyId: company.id, direction: "sideways", grain: "daily", postingDay: DAY } as never),
  );

  const spendDraft = preview(company.id, { direction: "spend", postingDay: DAY });
  const earnDraft = preview(company.id, { direction: "earn", postingDay: DAY });

  assert(
    spendDraft.docNumber !== earnDraft.docNumber,
    "the two directions get DIFFERENT document numbers on the same day — without direction " +
      "in the identity, daily:<day> named both and they would collide in QuickBooks",
  );
  assertEqual(spendDraft.direction, "spend", "the spend draft records its direction");
  assertEqual(earnDraft.direction, "earn", "and the revenue draft records its own");
  assert(
    spendDraft.lineIds.every((id) => !earnDraft.lineIds.includes(id)),
    "and the two drafts share no line",
  );

  // The payload each one actually carries.
  const spendClasses = spendDraft.payload.Line.map((l) => l.Description);
  const earnClasses = earnDraft.payload.Line.map((l) => l.Description);
  assert(
    spendClasses.some((d) => /Agent API spend/.test(d)),
    "the spend document books spend",
  );
  assert(
    !spendClasses.some((d) => /revenue/i.test(d)),
    "and carries no revenue line at all",
  );
  assert(
    earnClasses.some((d) => /Agent API revenue/.test(d)),
    "the revenue document books revenue",
  );
  assert(
    !earnClasses.some((d) => /Agent API spend/.test(d)),
    "and carries no spend line",
  );

  // REVIEW: claim 6, the display half. The first real revenue document is
  // permanent under 0008 §5, so the noun in it is permanent too.
  assert(
    earnClasses.some((d) => /— \d+ receipts?$/.test(d)),
    `a revenue line counts RECEIPTS, not payments (got: ${JSON.stringify(earnClasses)})`,
  );
  assert(
    /\d+ receipts?, \d+ agents?, \d+ (counterparty|counterparties)\./.test(
      earnDraft.payload.PrivateNote,
    ),
    `the PrivateNote pluralises properly rather than saying "counterparty(s)" ` +
      `(got: ${earnDraft.payload.PrivateNote})`,
  );
  assert(
    !earnClasses.some((d) => /payment/.test(d)),
    "the word 'payment' does not appear in a revenue document",
  );
  assert(
    !/0 receipt/.test(earnClasses.join("|")),
    "and the count is not zero — COUNT(ep.payment_id) reported 0 for every revenue line",
  );

  // The contra lands on the right side for a revenue-only entry: money arrived,
  // so the Fuel balance went UP and the contra is a Debit.
  const earnContra = earnDraft.payload.Line.find((l) => /Fuel balance/.test(l.Description))!;
  assertEqual(
    earnContra.JournalEntryLineDetail.PostingType,
    "Debit",
    "a revenue-only entry debits the contra — the balance rose",
  );
  assertEqual(
    earnContra.Description,
    "Received into Fuel balance",
    "and says so, rather than 'Funded from'",
  );

  // --- fingerprintFor covers receipts (the silent drop 0012 did not name) ---
  const earnPrint = fingerprintFor(earnDraft.lineIds);
  assertEqual(
    draftReadiness(earnDraft).ok,
    true,
    "a fresh revenue draft is postable",
  );
  // Absorb one more base unit of a receipt into the line. Under the old inner
  // join on payment_id this changed nothing at all: the fingerprint covered
  // none of a revenue line's sources.
  db.prepare(
    "UPDATE export_postings SET absorbed_base_units = absorbed_base_units + 1 WHERE receipt_id = 'dir-rec-0'",
  ).run();
  assert(
    fingerprintFor(earnDraft.lineIds) !== earnPrint,
    "a revenue draft's fingerprint MOVES when its receipts move — it was blind to them",
  );
  db.prepare(
    "UPDATE export_postings SET absorbed_base_units = absorbed_base_units - 1 WHERE receipt_id = 'dir-rec-0'",
  ).run();
  assertEqual(
    fingerprintFor(earnDraft.lineIds),
    earnPrint,
    "and returns to its old value when they move back",
  );

  // A spend-only draft must hash exactly as it did before the split, or every
  // open draft in existence is invalidated for no reason. Asserted rather than
  // reasoned about.
  const spendPrint = fingerprintFor(spendDraft.lineIds);
  const legacy = (() => {
    const placeholders = spendDraft.lineIds.map(() => "?").join(", ");
    const lines = db
      .prepare(
        `SELECT id, ledger_class, amount_base_units FROM posting_lines
          WHERE id IN (${placeholders}) ORDER BY id`,
      )
      .all(...(spendDraft.lineIds as never[])) as unknown as Record<string, unknown>[];
    const payments = db
      .prepare(
        `SELECT ep.line_id, p.id AS payment_id, p.status, ep.absorbed_base_units
           FROM export_postings ep
           JOIN payments p ON p.id = ep.payment_id
          WHERE ep.line_id IN (${placeholders})
          ORDER BY ep.line_id, p.id`,
      )
      .all(...(spendDraft.lineIds as never[])) as unknown as Record<string, unknown>[];
    return { lines, payments };
  })();
  const { canonicalHash } = await import("../src/db/qbo-postings.js");
  assertEqual(
    spendPrint,
    canonicalHash({
      lines: legacy.lines.map((l) => [l.id, l.ledger_class, String(l.amount_base_units)]),
      payments: legacy.payments.map((p) => [
        p.line_id,
        p.payment_id,
        p.status,
        String(p.absorbed_base_units),
      ]),
    }),
    "a spend-only draft hashes exactly as the pre-split query would have — no open draft is " +
      "invalidated by this change",
  );

  // --- generations do not interfere ---
  // Posting the spend document must not renumber the revenue one. Simulated by
  // writing the posting rows directly: this is about the generation counter,
  // not about Intuit.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO qbo_postings (id, company_id, draft_id, doc_number, request_id, status, created_at)
     VALUES ('dir-posting-1', ?, ?, ?, 'req-dir-1', 'posted', ?)`,
  ).run(company.id, spendDraft.id, spendDraft.docNumber, now);
  db.prepare("UPDATE qbo_posting_drafts SET status = 'posted' WHERE id = ?").run(spendDraft.id);

  const earnAgain = preview(company.id, { direction: "earn", postingDay: DAY });
  assertEqual(
    earnAgain.docNumber,
    earnDraft.docNumber,
    "posting the SPEND document does not bump the revenue document's generation — without " +
      "direction in postedGeneration's key the two would renumber each other",
  );

  // --- a revenue posting reverses ---
  // 0012 says buildReversal "should work" on revenue and that "should work" is
  // not "verified". This is the verification.
  const earnPosting = {
    id: "dir-posting-2",
    companyId: company.id,
    draftId: earnDraft.id,
    docNumber: earnDraft.docNumber,
    requestId: "req-dir-2",
    qboEntityId: "e1",
    qboSyncToken: "0",
    postedPayload: earnDraft.payload,
    postedPayloadHash: earnDraft.payloadHash,
    status: "posted" as const,
    detail: null,
    correctsPostingId: null,
    createdAt: now,
    postedAt: now,
    realmId: earnDraft.realmId,
    abandonedAt: null,
    abandonedBy: null,
    abandonReason: null,
    abandonEvidence: null,
  };
  const reversal = buildReversal(earnPosting);
  assertEqual(
    reversal.Line.length,
    earnDraft.payload.Line.length,
    "a revenue reversal has the same shape as the entry it reverses",
  );
  const revenueLine = earnDraft.payload.Line.find((l) => /Agent API revenue/.test(l.Description))!;
  const reversedRevenue = reversal.Line.find((l) => /Agent API revenue/.test(l.Description))!;
  assertEqual(
    revenueLine.JournalEntryLineDetail.PostingType,
    "Credit",
    "revenue posts as a Credit",
  );
  assertEqual(
    reversedRevenue.JournalEntryLineDetail.PostingType,
    "Debit",
    "and its reversal is a Debit — buildReversal is direction-neutral, now shown rather than assumed",
  );
  assert(
    reversal.Line.every((l) => l.Amount > 0),
    "every reversed amount is still positive",
  );

  // A revenue correction is filed as a revenue document, not a spend one.
  const correctionDraft = createDraft({
    companyId: company.id,
    direction: earnDraft.direction,
    grain: earnDraft.grain,
    postingDay: reversal.TxnDate,
    counterparty: earnDraft.counterparty,
    docNumber: reversal.DocNumber,
    payload: reversal,
    lineIds: earnDraft.lineIds,
    realmId: earnDraft.realmId,
  });
  assertEqual(
    correctionDraft.direction,
    "earn",
    "a revenue correction is a revenue document — filed as spend, its released lines would be " +
      "invisible to the direction that owns them",
  );

  console.log("   two documents, distinct numbers, independent generations, revenue reverses");
}

/**
 * Two companies, one day, one preview.
 *
 * THE DOCUMENT IS THE POINT. Everything else in this file can be wrong and
 * recovered from; a JournalEntry is a write into a third party's accounting
 * system, and ADR 0009 already names an export as the worst placement of a
 * scoping bug precisely because its output leaves Fuel permanently. A preview
 * that swept another tenant's lines would do that, as a write.
 *
 * The bidirectional half is the one that is easy to miss and is asserted last:
 * posting a draft marks every line it holds as consumed, so a preview that
 * borrowed the other company's lines would also strand them — and the other
 * company has no route to get them back, because reversal is scoped to the
 * posting's own company.
 */
async function verifyTenantIsolatedPreview(): Promise<void> {
  console.log("\n== a preview never reaches another company's lines ==");

  const { db } = await import("../src/db/index.js");
  const { bootstrapCompany } = await import("../src/db/companies.js");
  const { saveConnection, saveConfig } = await import("../src/db/qbo.js");
  const { eligibleLines } = await import("../src/db/qbo-postings.js");
  const { runPosting, listPostingLines } = await import("../src/db/postings.js");
  const { preview } = await import("../src/quickbooks/posting.js");

  const mine = bootstrapCompany();
  const DAY = "2019-07-08";

  const theirCompany = randomUUID();
  const theirTeam = randomUUID();
  const theirAgent = randomUUID();
  const theirName = `qbo-other-${theirCompany.slice(0, 8)}`;

  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    `INSERT INTO companies (id, name, spend_cap_base_units, created_at)
     VALUES (?, ?, 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(theirCompany, `QBO Other ${theirCompany.slice(0, 8)}`);
  db.prepare(
    `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
     VALUES (?, ?, 'Other Team', 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(theirTeam, theirCompany);
  db.prepare(
    `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                         spend_cap_base_units, created_at)
     VALUES (?, ?, ?, 'vault-qbo-other', '0xother', 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(theirAgent, theirName, theirTeam);
  // Same day as ours, and a whole number of cents so it is genuinely postable.
  for (let i = 0; i < 4; i += 1) {
    const at = `${DAY}T12:00:0${i}.000Z`;
    db.prepare(
      `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status,
                             detail, created_at, settled_at)
       VALUES (?, ?, 30000, 'https://qbo-other.test/x', 'settled', NULL, ?, ?)`,
    ).run(randomUUID(), theirAgent, at, at);
  }
  db.exec("COMMIT");

  // And ours, on the same day, so the preview has something of its own to find.
  const myAgent = (
    db
      .prepare(
        `SELECT a.id FROM agents a JOIN teams t ON t.id = a.team_id
         WHERE t.company_id = ? LIMIT 1`,
      )
      .get(mine.id) as { id: string }
  ).id;
  for (let i = 0; i < 4; i += 1) {
    const at = `${DAY}T09:00:0${i}.000Z`;
    db.prepare(
      `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status,
                             detail, created_at, settled_at)
       VALUES (?, ?, 30000, 'https://qbo-mine.test/x', 'settled', NULL, ?, ?)`,
    ).run(randomUUID(), myAgent, at, at);
  }
  // One run per company, as two operators would press it: the test needs
  // lines on BOTH sides to prove a preview cannot reach across.
  runPosting(mine.id);
  runPosting(theirCompany);

  const myLineIds = new Set(listPostingLines({ companyId: mine.id }).map((l) => l.id));
  const theirLineIds = new Set(
    listPostingLines({ companyId: theirCompany }).map((l) => l.id),
  );
  assert(theirLineIds.size > 0, "the other company really does have lines to be stolen");
  assert(
    [...theirLineIds].every((id) => !myLineIds.has(id)),
    "the two companies' line sets are disjoint to begin with",
  );

  // 1. Eligibility never crosses.
  const mineEligible = eligibleLines({
    companyId: mine.id,
    direction: "spend",
    grain: "daily",
    postingDay: DAY,
  });
  assert(mineEligible.length > 0, "our own day has eligible lines");
  assert(
    mineEligible.every((id) => !theirLineIds.has(id)),
    "no line of theirs is eligible for us",
  );

  saveConnection({
    companyId: mine.id,
    realmId: "9341457784003246",
    accessToken: "a",
    refreshToken: "r",
    accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  saveConfig(mine.id, {
    expenseAccountId: "63",
    suspenseAccountId: "91",
    contraAccountId: "35",
    revenueAccountId: "77",
    accountsRealmId: "9341457784003246",
    contraAccountKind: "prepaid_asset",
    rollupGrain: "daily",
    accountingCurrency: "USD",
    currencySource: "quickbooks_preferences",
    currencyCheckedAt: new Date().toISOString(),
  });

  // 2. The draft it persists, and the payload it sends, are both ours only.
  const draft = preview(mine.id, { direction: "spend", postingDay: DAY });
  assert(
    draft.lineIds.every((id) => !theirLineIds.has(id)),
    "the draft persists none of the other company's line ids",
  );
  assert(
    draft.lineIds.every((id) => myLineIds.has(id)),
    "every line the draft persists is one of ours",
  );
  const bound = db
    .prepare("SELECT line_id FROM qbo_draft_lines WHERE draft_id = ?")
    .all(draft.id) as unknown as { line_id: string }[];
  assert(
    bound.length > 0 && bound.every((r) => myLineIds.has(r.line_id)),
    "and the rows actually written to qbo_draft_lines are ours too",
  );
  // The number is minted for THIS company. A preview that passed the wrong
  // company -- or none -- would still produce a well-formed number, so this
  // pins which one. Generation 0: nothing has been posted on this day.
  assertEqual(
    draft.docNumber,
    docNumberFor(mine.id, `spend:daily:${DAY}`),
    "the draft's document number is derived from our company, not a shared scope",
  );
  assert(
    draft.docNumber !== docNumberFor(theirCompany, `spend:daily:${DAY}`),
    "so it cannot equal the number the other company would mint for the same day",
  );
  const sent = JSON.stringify(draft.payload);
  assert(!sent.includes(theirName), "the JournalEntry names no agent of theirs");
  assert(!sent.includes("qbo-other.test"), "and no counterparty of theirs");

  /*
   * 3. THE BIDIRECTIONAL HALF. Our preview must not have consumed their lines.
   *    Posting marks every line a draft holds as spent, and the exclusion that
   *    enforces that is global on purpose, so a draft that borrowed their lines
   *    would make them permanently unpostable for the company that owns them —
   *    with no route to release them, since reversal is scoped to the posting's
   *    own company.
   */
  const theirsAfter = eligibleLines({
    companyId: theirCompany,
    direction: "spend",
    grain: "daily",
    postingDay: DAY,
  });
  assert(
    theirsAfter.length > 0,
    "their lines are still eligible for them — our preview stranded nothing",
  );
  assert(
    theirsAfter.every((id) => theirLineIds.has(id)),
    "and what they can post is exactly their own",
  );
}

/**
 * 7A-3: every QuickBooks artifact records the books it belongs to.
 *
 * A QuickBooks token reaches only the company it was granted for, and every
 * call resolves the company from the CURRENT connection. So a posting, a draft
 * or an account mapping that does not say which books it was made against can
 * only ever be checked against whichever books are connected now -- the
 * failure 7A-3 exists to close. This section proves each writer stamps the
 * right books, including the two cases where "the right books" is NOT the
 * connected one: a reversal (the original's) and an attempt started after the
 * connection moved (the draft's).
 *
 * Its own company, so no other section's connection changes can reach it.
 * The fetch stub records the realm every request was addressed to, so each
 * assertion is about where a request went, not only what came back.
 */
async function verifyRealmRecording(): Promise<void> {
  console.log("\n== every QuickBooks artifact records the books it belongs to ==");

  const { db } = await import("../src/db/index.js");
  const { saveConfig, saveConnection, getConfig, AccountsRealmRequiredError } = await import(
    "../src/db/qbo.js"
  );
  const { setUpAccounts } = await import("../src/quickbooks/accounts.js");
  const { qboRequest, RealmMismatchError } = await import("../src/quickbooks/client.js");
  const { preview, post, postReversal } = await import("../src/quickbooks/posting.js");
  const { beginPosting, getDraftUnscoped, markPostingFailed } = await import(
    "../src/db/qbo-postings.js"
  );
  const { runPosting } = await import("../src/db/postings.js");

  const BOOKS_A = `books-a-${randomUUID().slice(0, 8)}`;
  const BOOKS_B = `books-b-${randomUUID().slice(0, 8)}`;
  const DAY = "2019-09-10";

  const companyId = randomUUID();
  const teamId = randomUUID();
  const agentId = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    `INSERT INTO companies (id, name, spend_cap_base_units, created_at)
     VALUES (?, ?, 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(companyId, `Realm Co ${companyId.slice(0, 8)}`);
  db.prepare(
    `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
     VALUES (?, ?, 'Realm Team', 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(teamId, companyId);
  db.prepare(
    `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                         spend_cap_base_units, created_at)
     VALUES (?, ?, ?, 'vault-realm', '0xrealm', 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(agentId, `realm-agent-${companyId.slice(0, 8)}`, teamId);
  for (let i = 0; i < 4; i += 1) {
    const at = `${DAY}T12:00:0${i}.000Z`;
    db.prepare(
      `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status,
                             detail, created_at, settled_at)
       VALUES (?, ?, 30000, 'https://realm.test/x', 'settled', NULL, ?, ?)`,
    ).run(randomUUID(), agentId, at, at);
  }
  db.exec("COMMIT");
  runPosting(companyId);

  saveConnection({
    companyId,
    realmId: BOOKS_A,
    accessToken: "not-a-real-access-token",
    accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: "not-a-real-refresh-token",
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  /** Switches the books UNDER Fuel: the state the connect guard exists to prevent. */
  const pointAt = (realm: string) =>
    db.prepare("UPDATE qbo_connections SET realm_id = ? WHERE company_id = ?").run(realm, companyId);

  const realFetch = globalThis.fetch;
  /** The realm each outgoing request was addressed to, and what it was. */
  let sent: { realm: string; method: string; path: string }[] = [];
  let nextEntityId = 7000;
  /** Runs inside a request, to move the connection while an operation is mid-flight. */
  let duringRequest: (() => void) | null = null;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    // /v3/company/<realm>/<path>
    const [, , , realm, ...rest] = url.pathname.split("/");
    sent.push({ realm: decodeURIComponent(realm ?? ""), method, path: rest.join("/") });
    if (duringRequest) {
      const hook = duringRequest;
      duringRequest = null;
      hook();
    }
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    const query = url.searchParams.get("query") ?? "";
    if (/FROM Account/.test(query)) {
      const name = /Name = '(.*)'/.exec(query)?.[1] ?? "";
      return json({ QueryResponse: { Account: [{ Id: `acct-${name.length}`, Name: name }] } });
    }
    if (/FROM Preferences/.test(query)) {
      return json({
        QueryResponse: { Preferences: [{ CurrencyPrefs: { HomeCurrency: { value: "USD" } } }] },
      });
    }
    if (rest[0] === "companyinfo") return json({ CompanyInfo: { CompanyName: "Realm Co", Country: "US" } });
    if (rest[0] === "journalentry" && method === "POST") {
      nextEntityId += 1;
      return json({ JournalEntry: { Id: String(nextEntityId), SyncToken: "0" } });
    }
    return json({});
  }) as typeof fetch;

  try {
    // --- 0. the choke point on its own ------------------------------------
    // Every refusal below rests on this one comparison, so it is proved first
    // and in isolation: a request pinned to other books never leaves.
    const pinned = (expectedRealm: string | null) =>
      qboRequest(companyId, { method: "GET", path: "query", query: "SELECT * FROM Preferences", expectedRealm });
    for (const [label, expected] of [
      ["pinned to different books", BOOKS_B],
      ["pinned to null -- a record Fuel could not attribute", null],
    ] as const) {
      sent = [];
      let refusal: unknown = null;
      try {
        await pinned(expected);
      } catch (error) {
        refusal = error;
      }
      assert(refusal instanceof RealmMismatchError, `a request ${label} is refused`);
      assertEqual(sent.length, 0, `and a request ${label} never leaves -- zero requests sent`);
      assert(
        !(refusal as Error).message.includes(BOOKS_A) && !(refusal as Error).message.includes(BOOKS_B),
        "and the refusal names no realm",
      );
    }
    // POSITIVE CONTROL: pinned to the connected books, it goes, and goes there.
    sent = [];
    await pinned(BOOKS_A);
    assert(sent.length === 1 && sent[0]!.realm === BOOKS_A, "a request pinned to the connected books is sent to them");

    // --- 0b. a reconnect in the middle of account setup refuses the rest ---
    // The reviewer's finding against this commit's first version: setUpAccounts
    // read the realm once and then let each request resolve the connection
    // afresh, so the ids after a mid-flight switch came from the new books
    // while the result still named the old ones.
    sent = [];
    duringRequest = () => pointAt(BOOKS_B);
    let midFlight: unknown = null;
    try {
      await setUpAccounts(companyId);
    } catch (error) {
      midFlight = error;
    }
    pointAt(BOOKS_A);
    assert(midFlight instanceof RealmMismatchError, "a reconnect part-way through account setup refuses the rest of it");
    assertEqual(sent.length, 1, "the request in flight when the books moved was the last one sent");
    assert(sent.every((r) => r.realm === BOOKS_A), "and nothing reached the books it moved to");

    // --- 1. account setup records the books it read the ids from ----------
    sent = [];
    const setup = await setUpAccounts(companyId);
    assertEqual(setup.realmId, BOOKS_A, "account setup reports the books its ids were read from");
    assert(sent.length > 0, "account setup asked QuickBooks for the accounts");
    assert(
      sent.every((r) => r.realm === BOOKS_A),
      "and every request it made was addressed to those books",
    );

    // --- 2. saveConfig refuses account ids with no stamp beside them -------
    let unstamped: unknown = null;
    try {
      saveConfig(companyId, { expenseAccountId: setup.expenseAccountId });
    } catch (error) {
      unstamped = error;
    }
    assert(
      unstamped instanceof AccountsRealmRequiredError,
      "an account id saved without the books it came from is refused",
    );
    assertEqual(getConfig(companyId).expenseAccountId, null, "and nothing was written");

    saveConfig(companyId, {
      expenseAccountId: setup.expenseAccountId,
      suspenseAccountId: setup.suspenseAccountId,
      contraAccountId: setup.contraAccountId,
      revenueAccountId: setup.revenueAccountId,
      accountsRealmId: setup.realmId,
      rollupGrain: "daily",
      accountingCurrency: "USD",
      currencySource: "quickbooks_preferences",
      currencyCheckedAt: new Date().toISOString(),
    });
    assertEqual(getConfig(companyId).accountsRealmId, BOOKS_A, "the mapping is stamped with its books");

    // A patch that touches no account id changes nothing the stamp speaks for.
    saveConfig(companyId, { accountingCurrency: "USD" });
    assertEqual(
      getConfig(companyId).accountsRealmId,
      BOOKS_A,
      "a currency-only save leaves the account stamp alone",
    );

    // --- 3. preview, post and reversal each record their books -------------
    const draft = preview(companyId, { direction: "spend", postingDay: DAY });
    assertEqual(draft.realmId, BOOKS_A, "a draft records the books it was built for");

    sent = [];
    const posted = await post(companyId, draft);
    assertEqual(posted.status, "posted", "the post went through the stubbed QuickBooks");
    assertEqual(posted.realmId, BOOKS_A, "a posting records the books it was sent to");
    assert(
      sent.length > 0 && sent.every((r) => r.realm === BOOKS_A),
      "and every request the post made went to those books",
    );

    sent = [];
    const reversal = await postReversal(companyId, posted);
    assertEqual(reversal.status, "posted", "the reversal went through");
    assertEqual(reversal.realmId, posted.realmId, "a reversal records the ORIGINAL's books");
    assertEqual(
      getDraftUnscoped(reversal.draftId)!.realmId,
      posted.realmId,
      "and so does the draft it was built from",
    );

    // --- 4. an attempt records the DRAFT's books, not the connected ones ---
    // Only distinguishable once the two disagree, so the connection is moved
    // under an open draft. After 7A-3's second commit post() refuses this
    // state outright; beginPosting is the record, and it is checked directly.
    const second = preview(companyId, { direction: "spend", postingDay: DAY });
    assertEqual(second.realmId, BOOKS_A, "the re-booking draft is for the same books");
    pointAt(BOOKS_B);
    const attempt = beginPosting({ companyId, draft: second, realmId: second.realmId });
    assertEqual(
      attempt.realmId,
      BOOKS_A,
      "an attempt records the books its draft was built for, even after the connection moved",
    );
    markPostingFailed(attempt.id, "verify-quickbooks: cleanup");
    pointAt(BOOKS_A);
  } finally {
    globalThis.fetch = realFetch;
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  assertEqual(violations.length, 0, "no foreign key violations");
  console.log("   setup, config, drafts, postings and reversals each carry their own books");
}

/**
 * 7A-3, the second half: nothing is ever sent to books other than the ones it
 * was made for.
 *
 * The books are switched by writing the connection row directly, bypassing the
 * connect route's guard -- the state that guard exists to prevent, and so the
 * state these defences have to survive. Two ways of switching, because they
 * reach different layers:
 *
 *   BEFORE an operation -- refused by the first request, which is pinned. So
 *   the assertion is "zero requests sent".
 *
 *   DURING an operation's first request -- that request was correctly pinned
 *   and went to the right books; what must catch it is the synchronous
 *   re-check before an attempt row exists. So the assertion is "no row".
 *
 * Every refusal is paired with a control (section 9) that switches back and
 * shows the same operation working, addressed to the right books. Without it,
 * each refusal here would pass just as well against code that refuses
 * everything.
 */
async function verifyRealmRefusals(): Promise<void> {
  console.log("\n== nothing is sent to books other than the ones it was made for ==");

  const { db } = await import("../src/db/index.js");
  const { saveConfig, saveConnection, AccountsFromOtherBooksError } = await import("../src/db/qbo.js");
  const { qboRequest, RealmMismatchError } = await import("../src/quickbooks/client.js");
  const { preview, post, postReversal, reconcilePending, DraftNotPostableError } = await import(
    "../src/quickbooks/posting.js"
  );
  const { eligibleLines, getDraftUnscoped, getPostingUnscoped } = await import(
    "../src/db/qbo-postings.js"
  );
  const { runPosting } = await import("../src/db/postings.js");

  const BOOKS_A = `refuse-a-${randomUUID().slice(0, 8)}`;
  const BOOKS_B = `refuse-b-${randomUUID().slice(0, 8)}`;
  const DAY = "2019-10-11";

  const companyId = randomUUID();
  const teamId = randomUUID();
  const agentId = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    `INSERT INTO companies (id, name, spend_cap_base_units, created_at)
     VALUES (?, ?, 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(companyId, `Refuse Co ${companyId.slice(0, 8)}`);
  db.prepare(
    `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
     VALUES (?, ?, 'Refuse Team', 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(teamId, companyId);
  db.prepare(
    `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                         spend_cap_base_units, created_at)
     VALUES (?, ?, ?, 'vault-refuse', '0xrefuse', 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(agentId, `refuse-agent-${companyId.slice(0, 8)}`, teamId);
  for (let i = 0; i < 4; i += 1) {
    const at = `${DAY}T12:00:0${i}.000Z`;
    db.prepare(
      `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status,
                             detail, created_at, settled_at)
       VALUES (?, ?, 30000, 'https://refuse.test/x', 'settled', NULL, ?, ?)`,
    ).run(randomUUID(), agentId, at, at);
  }
  db.exec("COMMIT");
  runPosting(companyId);

  const connectTo = (realm: string, accessExpiresAt = new Date(Date.now() + 3_600_000).toISOString()) =>
    saveConnection({
      companyId,
      realmId: realm,
      accessToken: "not-a-real-access-token",
      accessExpiresAt,
      refreshToken: "not-a-real-refresh-token",
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  connectTo(BOOKS_A);
  saveConfig(companyId, {
    expenseAccountId: "63",
    suspenseAccountId: "91",
    contraAccountId: "35",
    revenueAccountId: "77",
    accountsRealmId: BOOKS_A,
    rollupGrain: "daily",
    accountingCurrency: "USD",
    currencySource: "quickbooks_preferences",
    currencyCheckedAt: new Date().toISOString(),
  });
  const pointAt = (realm: string) =>
    db.prepare("UPDATE qbo_connections SET realm_id = ? WHERE company_id = ?").run(realm, companyId);
  const count = (table: string) =>
    Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ?`).get(companyId) as { n: number }).n,
    );
  const held = () =>
    eligibleLines({ companyId, direction: "spend", grain: "daily", postingDay: DAY }).length === 0;
  const setRealm = (table: string, id: string, realm: string | null) =>
    db.prepare(`UPDATE ${table} SET realm_id = ? WHERE id = ?`).run(realm, id);

  // --- the stub -------------------------------------------------------------
  const realFetch = globalThis.fetch;
  let sent: { realm: string; method: string; path: string }[] = [];
  let journalMode: "ok" | "unknown" | "duplicate" = "ok";
  /** Doc numbers that exist, per realm -- what a DocNumber query can find. */
  const existing = new Map<string, Set<string>>();
  let duringRequest: ((path: string) => boolean) | null = null;
  let nextEntityId = 8000;
  process.env.QBO_CLIENT_ID ??= "test-client-id";
  process.env.QBO_CLIENT_SECRET ??= "test-client-secret";
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (!url.pathname.startsWith("/v3/company/")) {
      // The token endpoint. Recorded like everything else: a refresh is a
      // write to the live connection, and a refused request must not cause one.
      sent.push({ realm: "(token endpoint)", method, path: url.pathname });
      return json({ access_token: "refreshed", refresh_token: "rotated", expires_in: 3600 });
    }
    const [, , , realmRaw, ...rest] = url.pathname.split("/");
    const realm = decodeURIComponent(realmRaw ?? "");
    const path = rest.join("/");
    sent.push({ realm, method, path });
    if (duringRequest && duringRequest(path)) duringRequest = null;

    const query = url.searchParams.get("query") ?? "";
    if (/FROM Preferences/.test(query)) {
      return json({ QueryResponse: { Preferences: [{ CurrencyPrefs: { HomeCurrency: { value: "USD" } } }] } });
    }
    if (/FROM JournalEntry/.test(query)) {
      const doc = /DocNumber = '(.*)'/.exec(query)?.[1] ?? "";
      return existing.get(realm)?.has(doc)
        ? json({ QueryResponse: { JournalEntry: [{ Id: "found-1", SyncToken: "0", DocNumber: doc }] } })
        : json({ QueryResponse: {} });
    }
    if (path.startsWith("companyinfo")) return json({ CompanyInfo: { CompanyName: "Refuse Co", Country: "US" } });
    if (path === "journalentry" && method === "POST") {
      if (journalMode === "unknown") return json({ Fault: { Error: [{ Message: "try later" }] } }, 503);
      if (journalMode === "duplicate") {
        return json({ Fault: { Error: [{ Message: "Duplicate Document Number Error", code: "6140" }] } }, 400);
      }
      nextEntityId += 1;
      return json({ JournalEntry: { Id: String(nextEntityId), SyncToken: "0" } });
    }
    return json({});
  }) as typeof fetch;
  /** Moves the books once, while the first request whose path matches is in flight. */
  const moveDuring = (match: (path: string) => boolean) => {
    duringRequest = (path) => {
      if (!match(path)) return false;
      pointAt(BOOKS_B);
      return true;
    };
  };
  const caught = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (error) {
      return error;
    }
  };

  try {
    // --- 0. a doomed request does not refresh anyone's token on the way out --
    // An expired token would be refreshed -- rotating and persisting the
    // connected company's credentials -- if the realm were only compared after
    // the token was resolved.
    connectTo(BOOKS_A, new Date(Date.now() - 60_000).toISOString());
    pointAt(BOOKS_B);
    sent = [];
    const doomed = await caught(() =>
      qboRequest(companyId, { method: "GET", path: "query", query: "SELECT * FROM Preferences", expectedRealm: BOOKS_A }),
    );
    assert(doomed instanceof RealmMismatchError, "a request for other books is refused with an expired token");
    assertEqual(sent.length, 0, "and it refreshed nothing -- no token request, no QuickBooks request");
    pointAt(BOOKS_A);
    connectTo(BOOKS_A);

    // --- 5. preview refuses a mapping read from other books ----------------
    pointAt(BOOKS_B);
    const draftsBefore = count("qbo_posting_drafts");
    let stale: unknown = null;
    try {
      preview(companyId, { direction: "spend", postingDay: DAY });
    } catch (error) {
      stale = error;
    }
    assert(
      stale instanceof AccountsFromOtherBooksError,
      "preview refuses when the account ids were read from other books",
    );
    assertEqual(count("qbo_posting_drafts"), draftsBefore, "and writes no draft");
    pointAt(BOOKS_A);
    db.prepare("UPDATE qbo_config SET accounts_realm_id = NULL WHERE company_id = ?").run(companyId);
    let unattributed: unknown = null;
    try {
      preview(companyId, { direction: "spend", postingDay: DAY });
    } catch (error) {
      unattributed = error;
    }
    assert(
      unattributed instanceof AccountsFromOtherBooksError,
      "preview refuses a mapping Fuel cannot attribute to any books (null)",
    );
    db.prepare("UPDATE qbo_config SET accounts_realm_id = ? WHERE company_id = ?").run(BOOKS_A, companyId);

    // --- 4. a stale draft is refused with nothing sent and no attempt ------
    const draft = preview(companyId, { direction: "spend", postingDay: DAY });
    pointAt(BOOKS_B);
    const attemptsBefore = count("qbo_postings");
    sent = [];
    const staleDraft = await caught(() => post(companyId, draft));
    assert(staleDraft instanceof RealmMismatchError, "posting a draft made for other books is refused");
    assertEqual(sent.length, 0, "and ZERO requests were sent, to either set of books");
    assertEqual(count("qbo_postings"), attemptsBefore, "and no attempt row was written");
    assertEqual(getDraftUnscoped(draft.id)!.status, "previewed", "and the draft is untouched");
    pointAt(BOOKS_A);

    // --- 4b. the books move DURING post's currency read --------------------
    sent = [];
    moveDuring((path) => path === "query");
    const during = await caught(() => post(companyId, draft));
    assert(
      during instanceof DraftNotPostableError,
      "a switch while post is reading the currency is caught before an attempt exists",
    );
    assertEqual(count("qbo_postings"), attemptsBefore, "so no attempt row was written");
    assert(!sent.some((r) => r.path === "journalentry"), "and no JournalEntry was sent");
    assert(sent.every((r) => r.realm === BOOKS_A), "and every request that went, went to the draft's books");
    pointAt(BOOKS_A);

    // --- 8a. a legacy draft Fuel could not attribute ------------------------
    setRealm("qbo_posting_drafts", draft.id, null);
    sent = [];
    const legacyDraft = await caught(() => post(companyId, getDraftUnscoped(draft.id)!));
    assert(legacyDraft instanceof RealmMismatchError, "a draft with no recorded books is refused, not trusted");
    assertEqual(sent.length, 0, "with nothing sent");
    assertEqual(count("qbo_postings"), attemptsBefore, "and no attempt row");
    setRealm("qbo_posting_drafts", draft.id, BOOKS_A);

    // A pending attempt: QuickBooks answered 503, so it may have landed.
    journalMode = "unknown";
    await caught(() => post(companyId, draft));
    journalMode = "ok";
    const pending = (
      db
        .prepare("SELECT id FROM qbo_postings WHERE company_id = ? AND status = 'pending'")
        .get(companyId) as { id: string }
    ).id;
    assertEqual(getPostingUnscoped(pending)!.realmId, BOOKS_A, "the pending attempt records the draft's books");
    assert(held(), "and holds its lines");

    // --- 2. RECONCILE AFTER A SWITCH: the double-booking path, closed ------
    pointAt(BOOKS_B);
    sent = [];
    const reconcileElsewhere = await caught(() => reconcilePending(companyId, getPostingUnscoped(pending)!));
    assert(
      reconcileElsewhere instanceof RealmMismatchError,
      "reconciling a pending posting after the books change is refused",
    );
    assertEqual(sent.length, 0, "without asking either set of books anything");
    assertEqual(
      getPostingUnscoped(pending)!.status,
      "pending",
      "the posting STAYS PENDING -- not marked failed on an answer from the wrong books",
    );
    assert(held(), "and its lines stay held, so the spend cannot be booked a second time");
    assert(
      /different QuickBooks company/.test(getPostingUnscoped(pending)!.detail ?? ""),
      "and the refused reconcile says why on the posting, for an operator",
    );
    pointAt(BOOKS_A);

    // --- 8b. a legacy pending attempt Fuel could not attribute -------------
    setRealm("qbo_postings", pending, null);
    sent = [];
    const legacyPending = await caught(() => reconcilePending(companyId, getPostingUnscoped(pending)!));
    assert(legacyPending instanceof RealmMismatchError, "a pending posting with no recorded books is not reconciled");
    assertEqual(sent.length, 0, "and nothing is asked");
    assertEqual(getPostingUnscoped(pending)!.status, "pending", "and it stays pending");
    setRealm("qbo_postings", pending, BOOKS_A);

    // --- 9a. CONTROL: back in the right books, reconcile works -------------
    existing.set(BOOKS_A, new Set([draft.docNumber]));
    sent = [];
    // Caught rather than awaited bare: a control must FAIL BY NAME against code
    // that refuses everything, not abort the suite with that code's refusal.
    const reconcileControl = await caught(() => reconcilePending(companyId, getPostingUnscoped(pending)!));
    assertEqual(
      getPostingUnscoped(pending)!.status,
      "posted",
      `CONTROL: with its own books connected, the posting reconciles (threw: ${(reconcileControl as Error | null)?.message ?? "nothing"})`,
    );
    const reconciled = getPostingUnscoped(pending)!;
    assert(sent.length > 0 && sent.every((r) => r.realm === BOOKS_A), "asking only those books");

    // --- 3. REVERSE AFTER A SWITCH ------------------------------------------
    const draftsNow = count("qbo_posting_drafts");
    const postingsNow = count("qbo_postings");
    pointAt(BOOKS_B);
    sent = [];
    const reverseElsewhere = await caught(() => postReversal(companyId, reconciled));
    assert(reverseElsewhere instanceof RealmMismatchError, "reversing after the books change is refused");
    assertEqual(sent.length, 0, "and nothing was sent for the refused reversal");
    assertEqual(count("qbo_posting_drafts"), draftsNow, "no correction draft was written for it");
    assertEqual(count("qbo_postings"), postingsNow, "and no correction attempt for it");
    pointAt(BOOKS_A);

    // --- 3b. the books move DURING the reversal's currency read -------------
    sent = [];
    moveDuring((path) => path === "query");
    const reverseDuring = await caught(() => postReversal(companyId, reconciled));
    assert(
      reverseDuring instanceof RealmMismatchError,
      "a switch while a reversal is reading the currency is caught before a correction exists",
    );
    assertEqual(count("qbo_posting_drafts"), draftsNow, "no correction draft was written mid-switch");
    assertEqual(count("qbo_postings"), postingsNow, "and no correction attempt mid-switch");
    assert(!sent.some((r) => r.path === "journalentry"), "and no reversing JournalEntry was sent mid-switch");
    pointAt(BOOKS_A);

    // --- 8c. a legacy posted document Fuel could not attribute -------------
    setRealm("qbo_postings", reconciled.id, null);
    sent = [];
    const legacyReverse = await caught(() => postReversal(companyId, getPostingUnscoped(reconciled.id)!));
    assert(legacyReverse instanceof RealmMismatchError, "a posting with no recorded books cannot be reversed");
    assertEqual(sent.length, 0, "and nothing is sent");
    assertEqual(count("qbo_postings"), postingsNow, "and no correction attempt for an unattributed original");
    setRealm("qbo_postings", reconciled.id, BOOKS_A);

    // --- 9b. CONTROL: back in the right books, reversal works --------------
    sent = [];
    let reversal = null as Awaited<ReturnType<typeof postReversal>> | null;
    const reverseControl = await caught(async () => {
      reversal = await postReversal(companyId, getPostingUnscoped(reconciled.id)!);
    });
    assertEqual(
      reversal?.status,
      "posted",
      `CONTROL: with the original's books connected, the reversal posts (threw: ${(reverseControl as Error | null)?.message ?? "nothing"})`,
    );
    if (!reversal) throw new Error("unreachable: asserted above");
    assertEqual(reversal.realmId, BOOKS_A, "into the original's books");
    assert(sent.every((r) => r.realm === BOOKS_A), "and nothing went anywhere else");

    // --- 7. A DUPLICATE-NUMBER FAULT, THEN A SWITCH -------------------------
    // Intuit says the number exists; Fuel goes to adopt that document. If the
    // books move between the fault and the lookup, the lookup must not be
    // asked of the new books -- "not found" there, plus a 4xx fault, is exactly
    // the combination that marks an attempt failed and releases its lines.
    const rebook = preview(companyId, { direction: "spend", postingDay: DAY });
    journalMode = "duplicate";
    moveDuring((path) => path === "journalentry");
    sent = [];
    const duplicate = await caught(() => post(companyId, rebook));
    journalMode = "ok";
    assert(duplicate instanceof RealmMismatchError, "adopting a duplicate after the books move is refused");
    const dupAttempt = db
      .prepare("SELECT * FROM qbo_postings WHERE draft_id = ?")
      .get(rebook.id) as { id: string; status: string; detail: string | null };
    assertEqual(
      dupAttempt.status,
      "pending",
      "A REALM REFUSAL NEVER CHANGES A POSTING'S STATUS: the attempt stays pending, not failed",
    );
    assert(/different QuickBooks company/.test(dupAttempt.detail ?? ""), "and says why, for an operator");
    assert(held(), "and its lines stay held");
    assert(!sent.some((r) => r.realm === BOOKS_B), "and nothing was asked of the books it moved to");
    pointAt(BOOKS_A);

    // --- 9c. CONTROL: the document is found where it really is --------------
    existing.set(BOOKS_A, new Set([draft.docNumber, rebook.docNumber]));
    await caught(() => reconcilePending(companyId, getPostingUnscoped(dupAttempt.id)!));
    assertEqual(
      getPostingUnscoped(dupAttempt.id)!.status,
      "posted",
      "CONTROL: reconciled in its own books, the duplicate is adopted",
    );
  } finally {
    globalThis.fetch = realFetch;
    duringRequest = null;
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  assertEqual(violations.length, 0, "no foreign key violations");
  console.log("   stale drafts, reconciles, reversals and adoptions refused; controls pass in the right books");
}

/**
 * 7A-3 item 3: an owner's way out when a pending posting's books are gone.
 *
 * What is under test is as much what a write-off does NOT do as what it does.
 * It lifts the guard on changing books for that one posting. It does not
 * change its status, release its lines, free its number or stop the generation
 * counting it -- the spend may already be in the lost books, and is never
 * re-posted automatically (the decision recorded in ADR 0016).
 *
 * And QuickBooks is always tried first: a write-off is refused whenever
 * QuickBooks can actually answer.
 */
async function verifyWriteOff(): Promise<void> {
  console.log("\n== an owner can write off a posting whose books cannot be asked -- and only then ==");

  const { db } = await import("../src/db/index.js");
  const { saveConfig, saveConnection, deleteConnection, UnresolvedPostingsError } = await import(
    "../src/db/qbo.js"
  );
  const { preview, post, reconcilePending, writeOffPending, QuickBooksAnsweredError, WriteOffRefusedError } =
    await import("../src/quickbooks/posting.js");
  const {
    beginPosting,
    createDraft,
    eligibleLines,
    getPostingUnscoped,
    markPostingAbandoned,
    pendingPostings,
    postedGeneration,
    DocumentInFlightError,
  } = await import("../src/db/qbo-postings.js");
  const { runPosting } = await import("../src/db/postings.js");

  const BOOKS_A = `wo-a-${randomUUID().slice(0, 8)}`;
  const BOOKS_B = `wo-b-${randomUUID().slice(0, 8)}`;
  const BOOKS_C = `wo-c-${randomUUID().slice(0, 8)}`;

  const companyId = randomUUID();
  const teamId = randomUUID();
  const agentId = randomUUID();
  const ownerId = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    `INSERT INTO companies (id, name, spend_cap_base_units, created_at)
     VALUES (?, ?, 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(companyId, `Write-off Co ${companyId.slice(0, 8)}`);
  db.prepare(
    `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
     VALUES (?, ?, 'Write-off Team', 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(teamId, companyId);
  db.prepare(
    `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                         spend_cap_base_units, created_at)
     VALUES (?, ?, ?, 'vault-wo', '0xwo', 1000000, '2099-01-01T00:00:00.000Z')`,
  ).run(agentId, `wo-agent-${companyId.slice(0, 8)}`, teamId);
  db.prepare(
    `INSERT INTO users (id, company_id, email, password_hash, role, created_at)
     VALUES (?, ?, ?, 'not-a-hash', 'owner', '2099-01-01T00:00:00.000Z')`,
  ).run(ownerId, companyId, `owner-${companyId.slice(0, 8)}@writeoff.test`);
  db.exec("COMMIT");

  const connectTo = (realm: string, accessExpiresAt = new Date(Date.now() + 3_600_000).toISOString()) =>
    saveConnection({
      companyId,
      realmId: realm,
      accessToken: "not-a-real-access-token",
      accessExpiresAt,
      refreshToken: "not-a-real-refresh-token",
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  connectTo(BOOKS_A);
  saveConfig(companyId, {
    expenseAccountId: "63",
    suspenseAccountId: "91",
    contraAccountId: "35",
    revenueAccountId: "77",
    accountsRealmId: BOOKS_A,
    rollupGrain: "daily",
    accountingCurrency: "USD",
    currencySource: "quickbooks_preferences",
    currencyCheckedAt: new Date().toISOString(),
  });
  const pointAt = (realm: string) =>
    db.prepare("UPDATE qbo_connections SET realm_id = ? WHERE company_id = ?").run(realm, companyId);

  // --- the stub ---------------------------------------------------------------
  const realFetch = globalThis.fetch;
  let sent: { realm: string; path: string }[] = [];
  /** How QuickBooks answers a DocNumber lookup this time. */
  let lookup: "found" | "not found" | "rejects the query" | "unavailable" = "unavailable";
  let tokenEndpoint: "ok" | "revoked" = "ok";
  let duringLookup: (() => void) | null = null;
  process.env.QBO_CLIENT_ID ??= "test-client-id";
  process.env.QBO_CLIENT_SECRET ??= "test-client-secret";
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (!url.pathname.startsWith("/v3/company/")) {
      sent.push({ realm: "(token endpoint)", path: url.pathname });
      return tokenEndpoint === "ok"
        ? json({ access_token: "refreshed", refresh_token: "rotated", expires_in: 3600 })
        : json({ error: "invalid_grant", error_description: "Token revoked" }, 400);
    }
    const [, , , realmRaw, ...rest] = url.pathname.split("/");
    const path = rest.join("/");
    sent.push({ realm: decodeURIComponent(realmRaw ?? ""), path });
    const query = url.searchParams.get("query") ?? "";
    if (/FROM Preferences/.test(query)) {
      return json({ QueryResponse: { Preferences: [{ CurrencyPrefs: { HomeCurrency: { value: "USD" } } }] } });
    }
    if (path.startsWith("companyinfo")) return json({ CompanyInfo: { CompanyName: "Write-off Co", Country: "US" } });
    if (/FROM JournalEntry/.test(query)) {
      if (duringLookup) {
        const hook = duringLookup;
        duringLookup = null;
        hook();
      }
      if (lookup === "found") return json({ QueryResponse: { JournalEntry: [{ Id: "wo-1", SyncToken: "0" }] } });
      if (lookup === "not found") return json({ QueryResponse: {} });
      if (lookup === "rejects the query") {
        return json({ Fault: { Error: [{ Message: "Invalid query", code: "4000" }] } }, 400);
      }
      return json({ Fault: { Error: [{ Message: "Service unavailable" }] } }, 503);
    }
    // A JournalEntry POST: 503, so the attempt it belongs to may have landed
    // and stays pending -- the state this whole section is about.
    if (path === "journalentry" && method === "POST") {
      return json({ Fault: { Error: [{ Message: "Service unavailable" }] } }, 503);
    }
    return json({});
  }) as typeof fetch;
  const caught = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (error) {
      return error;
    }
  };

  /** A posting whose outcome is unknown, on a day of its own. */
  let dayCounter = 10;
  const makePending = async () => {
    dayCounter += 1;
    const day = `2019-12-${String(dayCounter).padStart(2, "0")}`;
    for (let i = 0; i < 4; i += 1) {
      const at = `${day}T12:00:0${i}.000Z`;
      db.prepare(
        `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status,
                               detail, created_at, settled_at)
         VALUES (?, ?, 30000, 'https://wo.test/x', 'settled', NULL, ?, ?)`,
      ).run(randomUUID(), agentId, at, at);
    }
    runPosting(companyId);
    const draft = preview(companyId, { direction: "spend", postingDay: day });
    await caught(() => post(companyId, draft));
    const row = db
      .prepare("SELECT id FROM qbo_postings WHERE draft_id = ? AND status = 'pending'")
      .get(draft.id) as { id: string } | undefined;
    if (!row) throw new Error("FAILED: the fixture could not make a pending posting");
    return { posting: getPostingUnscoped(row.id)!, day, draft };
  };
  const writeOff = (postingId: string, reason = "The old QuickBooks company was cancelled.") =>
    caught(() => writeOffPending(companyId, getPostingUnscoped(postingId)!, { userId: ownerId, reason }));
  const held = (day: string) =>
    eligibleLines({ companyId, direction: "spend", grain: "daily", postingDay: day }).length === 0;

  try {
    // --- 1. QuickBooks answers "it exists": that answer stands --------------
    const p1 = await makePending();
    lookup = "found";
    const answeredFound = await writeOff(p1.posting.id);
    assert(answeredFound instanceof QuickBooksAnsweredError, "a write-off is refused when QuickBooks can say the document exists");
    assertEqual(getPostingUnscoped(p1.posting.id)!.status, "posted", "and the posting is resolved as a reconcile would resolve it");
    assertEqual(getPostingUnscoped(p1.posting.id)!.abandonedAt, null, "and nothing was written off");

    // --- 2. QuickBooks answers "it does not exist" ---------------------------
    const p2 = await makePending();
    lookup = "not found";
    const answeredMissing = await writeOff(p2.posting.id);
    assert(
      answeredMissing instanceof QuickBooksAnsweredError,
      "a write-off is refused when QuickBooks can say the document does not exist",
    );
    assertEqual(getPostingUnscoped(p2.posting.id)!.status, "failed", "and the posting is resolved to failed, as a reconcile would");
    assertEqual(getPostingUnscoped(p2.posting.id)!.abandonedAt, null, "and nothing was written off for it");

    // --- 3. QuickBooks is reachable but rejects the lookup --------------------
    const p3 = await makePending();
    lookup = "rejects the query";
    const rejected = await writeOff(p3.posting.id);
    assert(
      rejected instanceof WriteOffRefusedError,
      "a write-off is refused when QuickBooks is reachable and rejects the lookup itself",
    );
    assertEqual(getPostingUnscoped(p3.posting.id)!.status, "pending", "the posting is still pending");
    assertEqual(getPostingUnscoped(p3.posting.id)!.abandonedAt, null, "and was not written off");

    // --- 4a. QuickBooks unavailable: written off ------------------------------
    lookup = "unavailable";
    const unavailable = await writeOff(p3.posting.id);
    assertEqual(unavailable, null, "a write-off goes through when QuickBooks cannot be asked (503)");
    const w3 = getPostingUnscoped(p3.posting.id)!;
    assertEqual(w3.status, "pending", "A WRITE-OFF DOES NOT CHANGE THE STATUS: still pending, outcome unknown");
    assert(w3.abandonedAt !== null, "it records when");
    assertEqual(w3.abandonedBy, ownerId, "and which owner");
    assertEqual(w3.abandonReason, "The old QuickBooks company was cancelled.", "and the owner's reason");
    assert(/Service unavailable/.test(w3.abandonEvidence ?? ""), `and what Fuel saw (got: ${w3.abandonEvidence})`);

    // --- 4b. the connection points at other books ------------------------------
    const p4 = await makePending();
    pointAt(BOOKS_B);
    const elsewhere = await writeOff(p4.posting.id);
    pointAt(BOOKS_A);
    assertEqual(elsewhere, null, "a write-off goes through when the connection points at other books");
    assert(
      /different QuickBooks company/.test(getPostingUnscoped(p4.posting.id)!.abandonEvidence ?? ""),
      "and the evidence says so",
    );

    // --- 4c. the token cannot be refreshed (revoked) ---------------------------
    const p5 = await makePending();
    connectTo(BOOKS_A, new Date(Date.now() - 60_000).toISOString());
    tokenEndpoint = "revoked";
    const revoked = await writeOff(p5.posting.id);
    tokenEndpoint = "ok";
    connectTo(BOOKS_A);
    assertEqual(revoked, null, "a write-off goes through when the connection's token cannot be refreshed");
    assert(
      /token request failed/.test(getPostingUnscoped(p5.posting.id)!.abandonEvidence ?? ""),
      `and the evidence says so (got: ${getPostingUnscoped(p5.posting.id)!.abandonEvidence})`,
    );

    // --- 5. HELD MEANS HELD --------------------------------------------------
    assert(held(p3.day), "a written-off posting's lines stay held -- its spend is not re-posted");
    let twin: unknown = null;
    try {
      beginPosting({
        companyId,
        draft: createDraft({
          companyId,
          direction: "spend",
          grain: "daily",
          postingDay: p3.day,
          counterparty: null,
          docNumber: p3.posting.docNumber,
          payload: p3.draft.payload,
          lineIds: [],
          realmId: BOOKS_A,
        }),
        realmId: BOOKS_A,
      });
    } catch (error) {
      twin = error;
    }
    assert(twin instanceof DocumentInFlightError, "its document number stays taken");
    assertEqual(
      postedGeneration({ companyId, direction: "spend", grain: "daily", postingDay: p3.day, counterparty: null }),
      1,
      "and it still counts toward the generation, so a later document gets a fresh number",
    );
    assert(
      !pendingPostings(companyId).some((p) => p.id === p3.posting.id),
      "it leaves the needs-reconciliation list",
    );

    // --- 6. the guard lifts for written-off postings, and only for them ------
    const p6 = await makePending();
    let stillBlocked: unknown = null;
    try {
      connectTo(BOOKS_C);
    } catch (error) {
      stillBlocked = error;
    }
    assert(
      stillBlocked instanceof UnresolvedPostingsError,
      "CONTROL: an ordinary pending posting still blocks connecting different books",
    );
    let disconnectBlocked: unknown = null;
    try {
      deleteConnection(companyId);
    } catch (error) {
      disconnectBlocked = error;
    }
    assert(disconnectBlocked instanceof UnresolvedPostingsError, "CONTROL: and still blocks disconnecting");

    lookup = "unavailable";
    assertEqual(await writeOff(p6.posting.id), null, "the last ordinary pending posting is written off");
    let moved: unknown = null;
    try {
      connectTo(BOOKS_C);
    } catch (error) {
      moved = error;
    }
    assertEqual(moved, null, "WITH ONLY WRITTEN-OFF POSTINGS PENDING, the company can connect different books");
    let disconnected: unknown = null;
    try {
      disconnected = deleteConnection(companyId);
    } catch (error) {
      disconnected = error;
    }
    assertEqual(disconnected, true, "and can disconnect");

    // --- 7. the books come back: a reconcile still tells the truth -----------
    connectTo(BOOKS_A);
    lookup = "found";
    await caught(() => reconcilePending(companyId, getPostingUnscoped(p3.posting.id)!));
    const back = getPostingUnscoped(p3.posting.id)!;
    assertEqual(back.status, "posted", "with its own books reconnected, a written-off posting reconciles truthfully");
    assert(back.abandonedAt !== null, "and the write-off stays on it as history");

    // --- 8. twice, or a settled posting: refused, nothing changes -----------
    lookup = "unavailable";
    const onPosted = await writeOff(p3.posting.id);
    assert(onPosted instanceof WriteOffRefusedError, "a posted posting cannot be written off");
    const reasonBefore = getPostingUnscoped(p4.posting.id)!.abandonReason;
    const twice = await writeOff(p4.posting.id, "A different reason that must not replace the first.");
    assert(twice instanceof WriteOffRefusedError, "a posting cannot be written off twice");
    assertEqual(getPostingUnscoped(p4.posting.id)!.abandonReason, reasonBefore, "and the first reason is not overwritten");

    // --- 9. something resolves it while the write-off is trying QuickBooks ---
    const p7 = await makePending();
    lookup = "unavailable";
    duringLookup = () =>
      db.prepare("UPDATE qbo_postings SET status = 'failed' WHERE id = ?").run(p7.posting.id);
    const overtaken = await writeOff(p7.posting.id);
    assert(
      overtaken instanceof WriteOffRefusedError,
      "a posting resolved while the write-off was trying QuickBooks is not written off",
    );
    assertEqual(getPostingUnscoped(p7.posting.id)!.abandonedAt, null, "and the resolution stands, unmarked");

    const p8 = await makePending();
    duringLookup = () =>
      db
        .prepare(
          "UPDATE qbo_postings SET abandoned_at = ?, abandoned_by = ?, abandon_reason = 'first owner', abandon_evidence = 'x' WHERE id = ?",
        )
        .run(new Date().toISOString(), ownerId, p8.posting.id);
    const raced = await writeOff(p8.posting.id, "A second owner's reason, which must lose.");
    assert(raced instanceof WriteOffRefusedError, "a posting written off by someone else meanwhile is not written off again");
    assertEqual(getPostingUnscoped(p8.posting.id)!.abandonReason, "first owner", "and the first write-off's reason stands");

    // --- 9c. QuickBooks answered, and Fuel failed to RECORD the answer --------
    // Security review's finding: a plain failure after a real "it exists" (or
    // "it does not") used to read as "QuickBooks could not be asked", and the
    // posting was written off. A temporary trigger makes the recording fail.
    for (const [answer, becomes] of [["found", "posted"], ["not found", "failed"]] as const) {
      const p = await makePending();
      lookup = answer;
      db.exec(
        `CREATE TEMP TRIGGER wo_refuse_record BEFORE UPDATE OF status ON qbo_postings
         WHEN NEW.status = '${becomes}' BEGIN SELECT RAISE(ABORT, 'injected: cannot record'); END`,
      );
      let refusal: unknown = null;
      try {
        refusal = await writeOff(p.posting.id);
      } finally {
        db.exec("DROP TRIGGER IF EXISTS wo_refuse_record");
      }
      assert(
        refusal instanceof WriteOffRefusedError,
        `a write-off is refused when QuickBooks answered "${answer}" but Fuel could not record it`,
      );
      assertEqual(getPostingUnscoped(p.posting.id)!.abandonedAt, null, `and nothing was written off (${answer})`);
      assertEqual(getPostingUnscoped(p.posting.id)!.status, "pending", `and the posting is unchanged (${answer})`);
      // Tidy: resolve it truthfully now that recording works again.
      await caught(() => reconcilePending(companyId, getPostingUnscoped(p.posting.id)!));
    }
    lookup = "unavailable";

    // --- 10. the writer refuses an anonymous write-off -----------------------
    const p9 = await makePending();
    let anonymous: unknown = null;
    try {
      // NULL, not "": the users foreign key would refuse an unknown id on its
      // own, so "" could not tell whether the writer checks. NULL passes a
      // foreign key, so only the writer's own refusal stands in its way.
      markPostingAbandoned({
        postingId: p9.posting.id,
        userId: null as unknown as string,
        reason: "no one did this",
        evidence: "x",
      });
    } catch (error) {
      anonymous = error;
    }
    assert(anonymous instanceof Error, "a write-off naming nobody is refused by the writer");
    assertEqual(getPostingUnscoped(p9.posting.id)!.abandonedAt, null, "and writes nothing");
  } finally {
    globalThis.fetch = realFetch;
    duringLookup = null;
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  assertEqual(violations.length, 0, "no foreign key violations");
  console.log("   refused whenever QuickBooks answers; written off only when it cannot; nothing released");
}

/**
 * 7A-3 item 4: every connect link names the person who started it.
 *
 * The callback lets only that person finish it (verify-api drives that over
 * HTTP). This is the writer's half: the column arrived by ADD COLUMN and cannot
 * carry a CHECK, so createOAuthState is the only thing that keeps a nameless
 * state from being written at all.
 */
async function verifyOAuthStateWriter(): Promise<void> {
  console.log("\n== a connect link names who started it ==");
  const { createOAuthState, redeemOAuthState } = await import("../src/db/qbo.js");
  const { bootstrapCompany } = await import("../src/db/companies.js");
  const { db } = await import("../src/db/index.js");
  const companyId = bootstrapCompany().id;
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM qbo_oauth_states").get() as { n: number }).n;

  const before = count();
  for (const [what, userId] of [
    ["no user", undefined],
    ["an empty user", ""],
    ["a null user", null],
  ] as const) {
    refuses(`the writer refuses a connect link started by ${what}`, () =>
      createOAuthState({ state: randomUUID(), companyId, userId: userId as unknown as string }),
    );
  }
  assertEqual(count(), before, "and none of them wrote a row");

  const userId = randomUUID();
  db.prepare(
    `INSERT INTO users (id, company_id, email, password_hash, role, created_at)
     VALUES (?, ?, ?, 'not-a-hash', 'operator', '2099-01-01T00:00:00.000Z')`,
  ).run(userId, companyId, `starter-${userId.slice(0, 8)}@oauth.test`);
  const state = randomUUID();
  createOAuthState({ state, companyId, userId });
  const redeemed = redeemOAuthState(state);
  assert(redeemed.ok && redeemed.createdBy === userId, "a link started by a person is redeemed naming that person");
}

/**
 * 7A-3 item 4, part 2: which QuickBooks company Intuit granted, read from the
 * ID token. verify-api drives the callback over HTTP; these are the reader's
 * edges, which a stub response only brushes.
 */
function verifyGrantedRealm(): void {
  console.log("\n== the granted company comes from Intuit's ID token ==");
  process.env.QBO_CLIENT_ID ??= "test-client-id";
  const clientId = process.env.QBO_CLIENT_ID;
  const now = Date.UTC(2026, 8, 24, 12, 0, 0);
  const b64 = (value: unknown) =>
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const token = (claims: Record<string, unknown>) =>
    `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.c2lnbmF0dXJl`;
  const good = {
    iss: "https://oauth.platform.intuit.com/op/v1",
    aud: [clientId],
    realmid: "9341457987462698",
    sub: "someone",
    exp: Math.floor(now / 1000) + 60,
  };

  assertEqual(grantedRealm(token(good), now), "9341457987462698", "the realmid of a well-formed ID token is the granted company");
  assertEqual(grantedRealm(token({ ...good, aud: clientId }), now), "9341457987462698", "an audience given as a single string is accepted");
  assertEqual(
    grantedRealm(token({ ...good, aud: ["another-app", clientId] }), now),
    "9341457987462698",
    "an audience list that includes this app is accepted",
  );
  refuses("an audience list without this app", () => grantedRealm(token({ ...good, aud: ["another-app"] }), now));
  refuses("an ID token expiring this very millisecond", () => grantedRealm(token({ ...good, exp: now / 1000 }), now));
  assertEqual(
    grantedRealm(token({ ...good, exp: now / 1000 + 1 }), now),
    "9341457987462698",
    "one second before expiry is still good",
  );
  refuses("an expiry that is not a number", () => grantedRealm(token({ ...good, exp: String(good.exp) }), now));
  refuses("an issuer that only starts with Intuit's", () =>
    grantedRealm(token({ ...good, iss: "https://oauth.platform.intuit.com/op/v1.evil" }), now),
  );
  refuses("a realmid that is not a string", () => grantedRealm(token({ ...good, realmid: 9341457987462698 }), now));
  refuses("an empty realmid", () => grantedRealm(token({ ...good, realmid: "" }), now));
  refuses("a payload that is a JSON array", () => grantedRealm(`${b64({})}.${b64([good])}.sig`, now));
  refuses("a payload with standard-base64 characters", () => grantedRealm(`${b64({})}.${b64(good)}+/.sig`, now));
  refuses("no ID token", () => grantedRealm(undefined, now));
  refuses("four parts", () => grantedRealm(`${token(good)}.extra`, now));

  // Base64url without padding is the JWT norm; Buffer decodes it either way,
  // so a payload whose length is not a multiple of four must still read.
  const unpadded = { ...good, sub: "x" };
  assert(b64(unpadded).length % 4 !== 0, "(the next check really uses an unpadded payload)");
  assertEqual(grantedRealm(token(unpadded), now), "9341457987462698", "an unpadded base64url payload is read");

  let message = "";
  const secretish = token({ ...good, iss: "https://elsewhere.example" });
  try {
    grantedRealm(secretish, now);
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes("issuer"), "a refusal names the check that failed");
  for (const part of secretish.split(".")) {
    assert(!message.includes(part), "and carries no part of the token");
  }
  assert(!message.includes("9341457987462698") && !message.includes("elsewhere"), "and no claim value either");
}

async function main(): Promise<void> {
  verifySandboxGuard();
  verifyTokenEncryption();
  verifyMapper();
  verifyDocNumbers();
  await verifyDrafts();
  await verifyCompanyProfile();
  await verifyAccountSpecs();
  await verifyEmptyPreviewDiagnostics();
  await verifyCurrencyScope();
  await verifyPostTimeFreshness();
  await verifyDirection();
  await verifyTenantIsolatedPreview();
  await verifyRealmRecording();
  await verifyRealmRefusals();
  await verifyWriteOff();
  await verifyOAuthStateWriter();
  verifyGrantedRealm();
  console.log(`\nAll ${checks} checks passed.`);
  console.log(
    "\nNot covered here (needs an Intuit developer sandbox account): the live OAuth\n" +
      "handshake, account creation, and QuickBooks actually accepting a document.\n" +
      "See the live walkthrough in docs/roadmap.md.",
  );
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
