/**
 * Builds the database the verify suites run against, from nothing.
 *
 * WHY THIS EXISTS. verify-api, verify-rollup and verify-quickbooks used to start
 * from a file copy of the real `fuel.db`. That had three costs. The suites
 * depended on whatever that file happened to hold, so clearing old test data
 * could quietly turn an assertion off (verify-quickbooks' settlement check was
 * already skipping itself). A copy taken while the live API was writing could be
 * torn. And a machine without your `fuel.db` -- a collaborator's, or CI -- could
 * not run the suites at all.
 *
 * WHAT IT BUILDS. A company shaped like the real one: the same agents, the same
 * days of spend in the same statuses, the same approval history, an earning
 * endpoint with a settled receipt, a QuickBooks connection, posted documents and
 * a reversal -- plus an empty second sign-up and a QA company, because "another
 * company exists" is a fact several tenancy checks depend on.
 *
 * HOW. Rows that ARE history -- companies, agents, payments, approvals -- are
 * written directly with fixed ids and fixed past timestamps, the way the suites
 * write their own fixtures, because today's cap logic could not reproduce last
 * August (race-bot spent far past its current cap). Rows the product DERIVES --
 * rollup lines, drafts, postings, the reversal -- are made by the product's own
 * engines (runPosting, preview, beginPosting, markPosted, buildReversal), each
 * run on a frozen clock set to the day it happened, so they come out the way
 * those engines really produce them.
 *
 * WHAT IT NEVER DOES. It opens only the path it is given, which must be a new
 * file in the system temp directory. It reaches no network: QuickBooks is
 * written to as Intuit's answer would be recorded, with nothing sent, and no
 * Fireblocks module is imported. Its encryption key is generated per run, so
 * the tokens and forward secret it stores are unreadable to the suites --
 * exactly as the real database's were.
 *
 * Run by scripts/lib/test-db.ts in a child process, so the suite's own process
 * opens the result fresh.
 *
 *   node --import tsx scripts/lib/seed-test-db.ts <new file in the temp dir>
 */
import { createHash, randomBytes } from "node:crypto";

import { claimNewTempFile } from "./test-db-path.js";

const target = process.argv[2];
if (!target) throw new Error("usage: seed-test-db.ts <path to a new database file in the temp directory>");

/*
 * THE ONLY FILE THIS MAY OPEN, claimed before anything that can open a
 * database is imported (every such import below is dynamic, and comes after
 * this line). claimNewTempFile refuses anything but a new file in the temp
 * directory, creates it atomically, and returns the physical path it checked
 * -- which is the path opened, not the string that was passed in.
 */
const dbPath = claimNewTempFile(target);

process.env.FUEL_DB_PATH = dbPath;
process.env.FUEL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");

/**
 * A frozen clock, for the duration of `fn`.
 *
 * The engines stamp what they write with `new Date()`. Run on today's clock,
 * last August's posting run would claim to have happened this morning, and
 * every derived timestamp would differ between two runs of the suite. Set to
 * the moment the real event happened, the derived rows are historical and the
 * same on every run. Only `new Date()` and `Date.now()` are frozen; a date
 * built from a value is unaffected.
 */
const RealDate = Date;
function at<T>(iso: string, fn: () => T): T {
  const frozen = RealDate.parse(iso);
  if (Number.isNaN(frozen)) throw new Error(`not a timestamp: ${iso}`);
  class FrozenDate extends RealDate {
    constructor(...args: (string | number | Date)[]) {
      super(args.length === 0 ? frozen : args[0]!);
    }
    static override now(): number {
      return frozen;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/**
 * Fixed, valid v4-shaped UUIDs. `kind` is the first group, so ids sort by kind
 * and then by number -- which matters, because `SELECT id FROM agents LIMIT 1`
 * returns the smallest id. In the real database that is the QA company's agent,
 * not the main company's, and several suites were bitten by assuming otherwise;
 * the QA agent is given the smallest id here so that stays true.
 */
const uid = (kind: string, n: number): string =>
  `${kind.padEnd(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** A deterministic 32-byte hex string, for tx hashes and nonces. */
const hex32 = (label: string): string => createHash("sha256").update(label).digest("hex");

const { db } = await import("../../src/db/index.js");
const { hashPassword } = await import("../../src/lib/passwords.js");
const { runPosting, verifyPostingIntegrity } = await import("../../src/db/postings.js");
const { saveConnection, saveConfig } = await import("../../src/db/qbo.js");
const { beginPosting, createDraft, getDraftInCompany, getPostingInCompany, markPosted } = await import(
  "../../src/db/qbo-postings.js"
);
const { preview, buildReversal } = await import("../../src/quickbooks/posting.js");
const { registerEndpoint } = await import("../../src/db/earning-endpoints.js");

/* ---- the three companies ----------------------------------------------- */

const MAIN = uid("c0", 1);
const SECOND = uid("c0", 2);
const QA = uid("c0", 3);
const DEFAULT_TEAM = uid("7e", 1);
const TEAM_B = uid("7e", 2);
const QA_TEAM = uid("7e", 3);

db.exec("BEGIN IMMEDIATE");
try {
  /*
   * Boot already made the bootstrap company and its team, with random ids and
   * today's date. They are renamed in place rather than recreated, so the
   * bootstrap binding boot recorded stays the one the legacy credentials use.
   * Foreign keys are checked at COMMIT instead of per statement, because the
   * company's id and the rows pointing at it change in one step.
   */
  db.exec("PRAGMA defer_foreign_keys = ON");
  const boot = db.prepare("SELECT company_id FROM bootstrap_company WHERE id = 1").get() as {
    company_id: string;
  };
  const bootTeam = db.prepare("SELECT id FROM teams WHERE company_id = ?").get(boot.company_id) as {
    id: string;
  };
  db.prepare("UPDATE teams SET id = ?, company_id = ? WHERE id = ?").run(DEFAULT_TEAM, MAIN, bootTeam.id);
  db.prepare("UPDATE bootstrap_company SET company_id = ?, recorded_at = ? WHERE id = 1").run(
    MAIN,
    "2026-07-30T09:00:00.000Z",
  );
  db.prepare(
    `UPDATE companies SET id = ?, name = 'Fuel Test Company', handle = 'fuel-test-company',
            spend_cap_base_units = 5000000, created_at = '2026-07-30T09:00:00.000Z'
     WHERE id = ?`,
  ).run(MAIN, boot.company_id);
  db.prepare(
    `UPDATE teams SET name = 'Default Team', spend_cap_base_units = 21000,
            created_at = '2026-07-30T09:00:00.000Z' WHERE id = ?`,
  ).run(DEFAULT_TEAM);

  const company = db.prepare(
    "INSERT INTO companies (id, name, handle, spend_cap_base_units, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  // A second sign-up with nobody's agents in it yet, and the QA company: the
  // same two the real database holds.
  company.run(SECOND, "Second Sign-up", "second-sign-up", 0, "2026-09-23T21:39:58.000Z");
  company.run(QA, "Fuel QA Dashboard", "fuel-qa-dashboard", 0, "2026-09-27T14:03:25.000Z");

  const team = db.prepare(
    "INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  team.run(TEAM_B, MAIN, "Team B", 25000, "2026-08-01T09:00:00.000Z");
  team.run(QA_TEAM, QA, "QA", 0, "2026-09-27T14:03:25.000Z");
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

/* ---- agents --------------------------------------------------------------- */

const AGENTS = {
  research: uid("a0", 1),
  race: uid("a0", 2),
  trap: uid("a0", 3),
  emptyBalance: uid("a0", 4),
  signing: uid("a0", 5),
  qa: uid("0a", 1),
};

{
  // Inserted main company first, so a table scan meets one of its agents
  // first -- as it does in the real database.
  const agent = db.prepare(
    `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address, spend_cap_base_units, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const address = (name: string) => `0x${hex32(`address:${name}`).slice(0, 40)}`;
  agent.run(AGENTS.research, "research-bot", DEFAULT_TEAM, "test-vault-1", address("research"), 6_000_000, "2026-07-30T10:00:00.000Z");
  agent.run(AGENTS.race, "race-bot", DEFAULT_TEAM, "test-vault-2", address("race"), 3000, "2026-07-30T10:01:00.000Z");
  agent.run(AGENTS.trap, "trap-bot", DEFAULT_TEAM, "test-vault-3", address("trap"), 5000, "2026-07-30T10:02:00.000Z");
  agent.run(AGENTS.emptyBalance, "empty-balance-test-agent", DEFAULT_TEAM, "test-vault-4", address("empty"), 5000, "2026-08-01T10:00:00.000Z");
  agent.run(AGENTS.signing, "signing-test-agent", TEAM_B, "test-vault-5", address("signing"), 5000, "2026-08-01T10:01:00.000Z");
  agent.run(AGENTS.qa, "qa-dashboard-agent", QA_TEAM, "test-vault-6", address("qa"), 0, "2026-09-27T14:05:00.000Z");
}

/* ---- people ---------------------------------------------------------------- */

const PEOPLE = {
  owner: uid("05", 1),
  operator: uid("05", 2),
  secondOwner: uid("05", 3),
  qaOwner: uid("05", 4),
};
{
  // One hash for all four: nothing signs in as them. The suites make their own
  // people when they need a session, and these exist so "a company has users"
  // is true the way it is in the real database.
  const hash = await hashPassword(`test-database-${randomBytes(12).toString("hex")}`);
  const user = db.prepare(
    `INSERT INTO users (id, company_id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  user.run(PEOPLE.owner, MAIN, "owner@fuel-test.example", hash, "owner", "2026-08-02T12:30:00.000Z");
  user.run(PEOPLE.operator, MAIN, "operator@fuel-test.example", hash, "operator", "2026-08-02T12:31:00.000Z");
  user.run(PEOPLE.secondOwner, SECOND, "founder@second.fuel-test.example", hash, "owner", "2026-09-23T21:40:00.000Z");
  user.run(PEOPLE.qaOwner, QA, "qa-owner@fuel-test.example", hash, "owner", "2026-09-27T14:04:00.000Z");

  // The invites those people redeemed, including the founding one a script
  // minted for the second company.
  const invite = db.prepare(
    `INSERT INTO invites (id, token_hash, company_id, email, role, created_at, expires_at, redeemed_at, redeemed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  invite.run(uid("1e", 1), hex32("invite:1"), MAIN, "owner@fuel-test.example", "owner", "2026-08-02T12:25:00.000Z", "2026-08-09T12:25:00.000Z", "2026-08-02T12:30:00.000Z", PEOPLE.owner);
  invite.run(uid("1e", 2), hex32("invite:2"), MAIN, "operator@fuel-test.example", "operator", "2026-08-02T12:26:00.000Z", "2026-08-09T12:26:00.000Z", "2026-08-02T12:31:00.000Z", PEOPLE.operator);
  invite.run(uid("1e", 3), hex32("invite:3"), null, "founder@second.fuel-test.example", "owner", "2026-09-23T21:30:00.000Z", "2026-09-30T21:30:00.000Z", "2026-09-23T21:40:00.000Z", PEOPLE.secondOwner);
}

/* ---- payments and approvals, as they happened ------------------------------ */

let paymentSeq = 0;
const insertPayment = db.prepare(
  `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail,
                         created_at, settled_at, is_demo)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

interface Batch {
  agent: string;
  url: string;
  status: "settled" | "unreconciled" | "blocked" | "failed";
  count: number;
  amount?: number;
  /** Rotated across the batch, so one batch can carry several real-world reasons. */
  details?: (string | null)[];
  /** Settled rows that also carry settled_at, which only rows after 2026-08-03 do. */
  settledAt?: boolean;
  demo?: boolean;
}

/** Writes a day's batches, spaced a minute apart from 10:00, and returns the ids by batch. */
function day(date: string, batches: Batch[]): string[][] {
  let minute = 0;
  return batches.map((b) =>
    Array.from({ length: b.count }, (_, i) => {
      const id = uid("9a", (paymentSeq += 1));
      const created = new RealDate(RealDate.parse(`${date}T10:00:00.000Z`) + (minute += 1) * 60_000);
      const settled = b.status === "settled";
      insertPayment.run(
        id,
        b.agent,
        b.amount ?? 1000,
        b.url,
        b.status,
        settled || b.demo ? `0x${hex32(`tx:${id}`)}` : null,
        b.details ? b.details[i % b.details.length]! : null,
        created.toISOString(),
        settled && b.settledAt ? new RealDate(created.getTime() + 9_000).toISOString() : null,
        b.demo ? 1 : 0,
      );
      return id;
    }),
  );
}

const LOCAL = "http://localhost:3000/paid-hello";
const LOOP = "http://127.0.0.1:3000/paid-hello";
const LOOP_10 = "http://127.0.0.1:3010/paid-hello";
const NO_HEADER = "HTTP 402 with no PAYMENT-REQUIRED header";

const insertApproval = db.prepare(
  `INSERT INTO approval_requests (id, agent_id, amount_base_units, resource_url, blocked_scope, status,
                                  approval_expires_at, payment_id, created_at, decided_at, detail, is_demo)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
let approvalSeq = 0;
function approval(p: {
  status: "approved" | "denied" | "consumed" | "expired";
  scope: "team" | "company" | "anomaly";
  url: string;
  amount: number;
  createdAt: string;
  paymentId?: string;
  detail?: string | null;
  expires?: boolean;
  demo?: boolean;
}): void {
  const created = RealDate.parse(p.createdAt);
  insertApproval.run(
    uid("ab", (approvalSeq += 1)),
    AGENTS.research,
    p.amount,
    p.url,
    p.scope,
    p.status,
    // Every decision here was made with a shared key, as in the real database,
    // so none names a person (decided_by stays NULL).
    p.expires ? new RealDate(created + 4_000 + 15 * 60_000).toISOString() : null,
    p.paymentId ?? null,
    p.createdAt,
    new RealDate(created + 4_000).toISOString(),
    p.detail ?? null,
    p.demo ? 1 : 0,
  );
}

const ANOMALY = "0.005 is unusual for this agent: above the 0.003 threshold, against a median of 0.001 over 18 recent payments";

db.exec("BEGIN IMMEDIATE");
try {
  day("2026-07-30", [
    { agent: AGENTS.race, url: LOCAL, status: "settled", count: 3 },
    { agent: AGENTS.race, url: LOCAL, status: "blocked", count: 4, details: ["would exceed agent spend cap"] },
    { agent: AGENTS.race, url: LOCAL, status: "failed", count: 1, details: [NO_HEADER] },
    { agent: AGENTS.research, url: LOCAL, status: "settled", count: 5 },
    { agent: AGENTS.research, url: LOCAL, status: "blocked", count: 2, details: ["would exceed spend cap"] },
  ]);
  day("2026-08-01", [
    { agent: AGENTS.emptyBalance, url: LOOP_10, status: "unreconciled", count: 1, details: ["invalid_exact_evm_insufficient_balance"] },
    { agent: AGENTS.race, url: LOOP, status: "blocked", count: 1, details: ["would exceed global spend ceiling"] },
    { agent: AGENTS.race, url: LOOP, status: "settled", count: 1 },
    { agent: AGENTS.research, url: LOOP, status: "blocked", count: 2, details: ["would exceed global spend ceiling"] },
    { agent: AGENTS.research, url: LOOP_10, status: "settled", count: 1 },
    { agent: AGENTS.signing, url: LOOP_10, status: "blocked", count: 1, details: ["would exceed team spend cap"] },
    { agent: AGENTS.signing, url: LOOP_10, status: "settled", count: 2 },
    { agent: AGENTS.trap, url: LOOP, status: "blocked", count: 2, details: ["would exceed company spend cap"] },
    { agent: AGENTS.trap, url: LOOP, status: "settled", count: 5 },
  ]);
  const [, , , researchSettled, , , , researchAnomalySettled] = day("2026-08-02", [
    { agent: AGENTS.emptyBalance, url: LOCAL, status: "blocked", count: 1, details: ["agent is frozen (since 2026-08-02T21:59:28.993Z)"] },
    { agent: AGENTS.research, url: LOOP, status: "blocked", count: 1, details: ["would exceed spend cap"] },
    {
      agent: AGENTS.research,
      url: LOCAL,
      status: "blocked",
      count: 55,
      details: [
        "would exceed team spend cap",
        "rate limited: 20000 + 1000 base units exceeds 20000 per 60s; retry in ~60s",
        "would exceed team spend cap",
        "would exceed agent spend cap",
        "approval refused: approval is consumed, not approved",
        "would exceed team spend cap",
        "approval refused: approval has expired",
        "approval refused: approval belongs to a different agent",
        "would exceed company spend cap",
        "approval refused: payment costs more than was approved",
        "approval refused: approval was granted for a different resource",
      ],
    },
    { agent: AGENTS.research, url: LOCAL, status: "settled", count: 27 },
    // The out-of-character payments: blocked as anomalies, one later approved.
    {
      agent: AGENTS.research,
      url: LOCAL,
      status: "blocked",
      count: 8,
      amount: 5000,
      details: ["flagged as anomalous: 5000 base units is above the threshold of 3000 (median 1000 over 18 recent payments)"],
    },
    {
      agent: AGENTS.research,
      url: LOCAL,
      status: "unreconciled",
      count: 26,
      details: [
        NO_HEADER,
        NO_HEADER,
        NO_HEADER,
        "unexpected_error: RPC Request failed. URL: https://sepolia.base.org",
      ],
    },
    { agent: AGENTS.signing, url: LOCAL, status: "blocked", count: 3, details: ["would exceed team spend cap"] },
    { agent: AGENTS.research, url: LOCAL, status: "settled", count: 1, amount: 5000 },
    { agent: AGENTS.signing, url: LOCAL, status: "settled", count: 1, amount: 5000 },
    { agent: AGENTS.signing, url: LOCAL, status: "settled", count: 1 },
  ]);
  const [, lateSettled] = day("2026-08-03", [
    { agent: AGENTS.research, url: LOCAL, status: "blocked", count: 1, details: ["would exceed team spend cap"] },
    { agent: AGENTS.research, url: LOCAL, status: "settled", count: 1, settledAt: true },
  ]);

  // The approval history: every one decided with the shared key. Consumed ones
  // are tied to the payment they let through, so the rollup's drill-down can
  // trace a posted payment back to the decision that authorized it.
  for (let i = 0; i < 7; i += 1) {
    approval({ status: "consumed", scope: "team", url: LOCAL, amount: 1000, createdAt: `2026-08-02T15:0${i}:00.000Z`, paymentId: researchSettled![i]!, expires: true });
  }
  approval({ status: "consumed", scope: "anomaly", url: LOCAL, amount: 5000, createdAt: "2026-08-02T15:30:00.000Z", paymentId: researchAnomalySettled![0]!, detail: ANOMALY, expires: true });
  approval({ status: "consumed", scope: "team", url: LOCAL, amount: 1000, createdAt: "2026-08-03T10:00:30.000Z", paymentId: lateSettled![0]!, expires: true });
  for (let i = 0; i < 3; i += 1) {
    approval({ status: "denied", scope: "team", url: LOCAL, amount: 1000, createdAt: `2026-08-02T16:0${i}:00.000Z` });
    approval({ status: "denied", scope: "anomaly", url: LOCAL, amount: 5000, createdAt: `2026-08-02T16:1${i}:00.000Z`, detail: ANOMALY });
  }
  for (let i = 0; i < 2; i += 1) {
    approval({ status: "expired", scope: "team", url: LOCAL, amount: 1000, createdAt: `2026-08-02T17:0${i}:00.000Z`, detail: "approved but not redeemed before it expired", expires: true });
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

/* ---- QuickBooks: connected, configured, verified ------------------------------ */

const MAIN_REALM = "9341450000000001";
at("2026-08-25T15:00:00.000Z", () => {
  // Written as Intuit's answer would be recorded. The tokens are placeholders,
  // encrypted under this run's own key, so no suite can read them back -- as
  // with the real database, whose tokens are under a key no suite has.
  saveConnection({
    companyId: MAIN,
    realmId: MAIN_REALM,
    accessToken: "test-database-access-token",
    accessExpiresAt: "2026-09-13T23:22:00.000Z",
    refreshToken: "test-database-refresh-token",
    // Far off, so a run next year does not suddenly find it expiring.
    refreshExpiresAt: "2099-01-04T00:00:00.000Z",
  });
  saveConfig(MAIN, {
    expenseAccountId: "58",
    suspenseAccountId: "59",
    contraAccountId: "35",
    revenueAccountId: "79",
    accountsRealmId: MAIN_REALM,
    contraAccountKind: "prepaid_asset",
    rollupGrain: "daily",
    accountingCurrency: "USD",
    currencySource: "quickbooks_preferences",
    currencyCheckedAt: "2026-08-25T15:00:00.000Z",
  });
});
at("2026-09-23T21:45:00.000Z", () => {
  saveConnection({
    companyId: SECOND,
    realmId: "9341450000000002",
    accessToken: "test-database-access-token-2",
    accessExpiresAt: "2026-09-23T22:45:00.000Z",
    refreshToken: "test-database-refresh-token-2",
    refreshExpiresAt: "2099-01-04T00:00:00.000Z",
  });
});

/**
 * A document reaching QuickBooks, recorded the way `post()` records Intuit's
 * confirmation -- reserve the attempt, then mark it posted -- with nothing
 * sent. The entity id is a placeholder no real QuickBooks company holds.
 */
let entitySeq = 0;
function postDraft(draftId: string): string {
  const draft = getDraftInCompany(draftId, MAIN)!;
  const attempt = beginPosting({ companyId: MAIN, draft, realmId: draft.realmId });
  markPosted({ postingId: attempt.id, qboEntityId: `test-${(entitySeq += 1)}`, qboSyncToken: "0", payload: draft.payload });
  return attempt.id;
}

// The first run, the evening the August spend happened.
at("2026-08-03T18:00:00.000Z", () => runPosting(MAIN));

/* ---- the demo day, and the settlement a day later ------------------------------ */

db.exec("BEGIN IMMEDIATE");
try {
  const SERP = "https://api.serpstack.test/v1/search";
  const CRAWL = "https://api.firecrawl.test/v1/scrape";
  const [researchSerp, researchCrawl] = day("2026-08-24", [
    { agent: AGENTS.research, url: SERP, status: "settled", count: 40, details: ["demo-seed"], settledAt: true, demo: true },
    { agent: AGENTS.research, url: CRAWL, status: "settled", count: 30, details: ["demo-seed"], settledAt: true, demo: true },
    { agent: AGENTS.research, url: CRAWL, status: "unreconciled", count: 20, details: ["demo-seed"], demo: true },
    { agent: AGENTS.race, url: SERP, status: "settled", count: 20, details: ["demo-seed"], settledAt: true, demo: true },
  ]);
  approval({ status: "approved", scope: "team", url: SERP, amount: 1000, createdAt: "2026-08-24T10:01:00.000Z", paymentId: researchSerp![0]!, detail: "demo-seed", demo: true });
  approval({ status: "approved", scope: "team", url: SERP, amount: 1000, createdAt: "2026-08-24T10:02:00.000Z", paymentId: researchSerp![1]!, detail: "demo-seed", demo: true });
  approval({ status: "approved", scope: "anomaly", url: CRAWL, amount: 1000, createdAt: "2026-08-24T10:41:00.000Z", paymentId: researchCrawl![0]!, detail: "demo-seed", demo: true });
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

at("2026-08-25T16:00:00.000Z", () => {
  runPosting(MAIN);
  // An operator previews August 2nd and walks away: a draft that never posts.
  preview(MAIN, { direction: "spend", postingDay: "2026-08-02" });
  // Previews the demo day twice and posts the second.
  preview(MAIN, { direction: "spend", postingDay: "2026-08-24" });
  postDraft(preview(MAIN, { direction: "spend", postingDay: "2026-08-24" }).id);
});

// The demo day's unconfirmed payments settle the next day. Dated by when the
// money moved, so their reclassification lands on the 25th.
db.prepare(
  `UPDATE payments SET status = 'settled', settled_at = '2026-08-25T19:30:00.000Z'
   WHERE is_demo = 1 AND status = 'unreconciled'`,
).run();

at("2026-08-25T19:35:00.000Z", () => {
  runPosting(MAIN);
  postDraft(preview(MAIN, { direction: "spend", postingDay: "2026-08-25" }).id);
  // August 2nd again: one more preview left standing, then the one that posts.
  preview(MAIN, { direction: "spend", postingDay: "2026-08-02" });
  postDraft(preview(MAIN, { direction: "spend", postingDay: "2026-08-02" }).id);
});

/* ---- revenue, posted and then reversed ---------------------------------------- */

const earnedPosting = at("2026-09-13T22:20:00.000Z", () => {
  const { endpoint } = registerEndpoint({
    agentId: AGENTS.research,
    originUrl: "https://origin.fuel-test.example/forecast",
    priceBaseUnits: 50_000n,
    label: "Revenue walkthrough 2026-09-13",
  });
  db.prepare(
    `INSERT INTO receipts (id, agent_id, endpoint_id, amount_base_units, status, payer_address,
                           authorization_nonce, tx_hash, created_at, settled_at)
     VALUES (?, ?, ?, 50000, 'settled', ?, ?, ?, '2026-09-13T22:10:00.000Z', '2026-09-13T22:10:09.000Z')`,
  ).run(uid("4e", 1), AGENTS.research, endpoint.id, `0x${hex32("payer").slice(0, 40)}`, `0x${hex32("nonce")}`, `0x${hex32("receipt-tx")}`);
  runPosting(MAIN);
  return postDraft(preview(MAIN, { direction: "earn", postingDay: "2026-09-13" }).id);
});

at("2026-09-13T22:25:00.000Z", () => {
  /*
   * The reversal, by postReversal's own local steps: build it from the posted
   * original, give it a draft carrying the original's lines, reserve and record
   * it. What postReversal adds -- re-reading the currency from Intuit, and
   * sending -- is the network half, and is the half left out.
   */
  const original = getPostingInCompany(earnedPosting, MAIN)!;
  const payload = buildReversal(original);
  const originalDraft = getDraftInCompany(original.draftId, MAIN)!;
  const draft = createDraft({
    companyId: MAIN,
    direction: originalDraft.direction,
    grain: originalDraft.grain,
    postingDay: payload.TxnDate,
    counterparty: originalDraft.counterparty,
    docNumber: payload.DocNumber,
    payload,
    lineIds: originalDraft.lineIds,
    realmId: original.realmId,
  });
  const attempt = beginPosting({ companyId: MAIN, draft, correctsPostingId: original.id, realmId: original.realmId });
  markPosted({ postingId: attempt.id, qboEntityId: `test-${(entitySeq += 1)}`, qboSyncToken: "0", payload });
});

/* ---- the database must be sound before any suite trusts it --------------------- */

/*
 * A seeder that wrote an inconsistent ledger would make every suite after it
 * test the wrong thing, and their failures would point at the product. So it
 * checks its own work with the product's own checker and refuses to finish
 * otherwise.
 */
const problems = verifyPostingIntegrity(MAIN);
if (problems.length > 0) {
  throw new Error(`the test database's books do not balance: ${problems.map((p) => `${p.check}: ${p.detail}`).join("; ")}`);
}
const fk = db.prepare("PRAGMA foreign_key_check").all();
if (fk.length > 0) throw new Error(`the test database has ${fk.length} foreign key violation(s)`);
const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
if (integrity !== "ok") throw new Error(`the test database failed integrity_check: ${integrity}`);

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
console.log(
  `test database: ${count("companies")} companies, ${count("agents")} agents, ${count("payments")} payments, ` +
    `${count("approval_requests")} approvals, ${count("posting_lines")} rollup lines, ` +
    `${count("qbo_postings")} QuickBooks postings`,
);
db.close();
