/**
 * The 6A-1 ledger migration, verified against a database in the OLD shape.
 *
 * Everything else in this slice is checked by verify-rollup and
 * verify-quickbooks still passing at their old counts, which proves the new
 * code did not change behaviour. It does NOT prove the migration works, because
 * those suites build their databases fresh and so never take the migration
 * path at all. A migration that only runs on developer machines that have
 * already run it is a migration nobody has tested.
 *
 * So this builds a database in the pre-6A-1 shape, on purpose, and migrates it.
 *
 * The check that matters most is the last one. The composite primary key
 * `(payment_id, line_id)` was replaced by two partial unique indexes
 * specifically because SQLite permits NULLs inside a PRIMARY KEY on a
 * non-INTEGER column in a non-STRICT table — so keeping the key and making
 * payment_id nullable would have silently stopped preventing duplicate
 * absorption, with no error anywhere. That claim is worth testing rather than
 * trusting, in both directions.
 *
 * Runs entirely on a scratch database in a temp directory. fuel.db is never
 * opened.
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) {
    throw new Error(`FAILED: ${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`   ok  ${label}`);
}

function throws(label: string, fn: () => void, expect: RegExp): void {
  checks += 1;
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!expect.test(message)) {
      throw new Error(`FAILED: ${label} — threw, but with "${message}"`);
    }
    console.log(`   ok  ${label}`);
    return;
  }
  throw new Error(`FAILED: ${label} — did not throw, and it must`);
}

/**
 * Boots src/db/index.ts against a database path, running every migration.
 *
 * `--import tsx`, not `--experimental-strip-types`. Node's own type stripping
 * does not rewrite a `.js` specifier to the `.ts` file beside it, so the moment
 * anything under src/ imported a NEW module this spawned child failed to
 * resolve it — while every other suite, which runs under tsx, kept passing.
 * 6A-2 lost time to the identical trap in verify-earning; the runner has to
 * match what the code is written against, not what happens to work today.
 */
function boot(dbPath: string): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--no-warnings", "-e", 'import("./src/db/index.ts");'],
    { env: { ...process.env, FUEL_DB_PATH: dbPath }, encoding: "utf8", stdio: "pipe" },
  );
}

/**
 * Rebuilds qbo_postings in an EARLIER shape, keeping its rows.
 *
 * A rebuild rather than DROP COLUMN because the later columns cannot all be
 * dropped: `abandoned_by` is a foreign key, and SQLite refuses to drop one. It
 * also models the real thing more faithfully -- an old database never HAD
 * these columns, rather than having had them removed.
 *
 *   "pre-7A-3"   -- before item 2: no realm_id, no write-off columns.
 *   "item-2"     -- the live database's shape between items 2 and 3.
 *
 * The partial unique index is dropped with the table and recreated by the next
 * boot (enforceOneLiveAttemptPerDocNumber), as on a real migration.
 */
function rebuildPostingsAs(db: DatabaseSync, shape: "pre-7A-3" | "item-2"): void {
  const original = `id, company_id, draft_id, doc_number, request_id, qbo_entity_id, qbo_sync_token,
      posted_payload_json, posted_payload_hash, status, detail, corrects_posting_id, created_at, posted_at`;
  const kept = shape === "item-2" ? `${original}, realm_id` : original;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DROP TABLE IF EXISTS qbo_postings_old");
  db.exec(`
    CREATE TABLE qbo_postings_old (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id),
      draft_id            TEXT NOT NULL REFERENCES qbo_posting_drafts(id),
      doc_number          TEXT NOT NULL,
      request_id          TEXT NOT NULL,
      qbo_entity_id       TEXT,
      qbo_sync_token      TEXT,
      posted_payload_json TEXT,
      posted_payload_hash TEXT,
      status              TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'failed')),
      detail              TEXT,
      corrects_posting_id TEXT REFERENCES qbo_postings(id),
      created_at          TEXT NOT NULL,
      posted_at           TEXT${shape === "item-2" ? ",\n      realm_id            TEXT" : ""}
    )
  `);
  db.exec(`INSERT INTO qbo_postings_old (${kept}) SELECT ${kept} FROM qbo_postings`);
  db.exec("DROP TABLE qbo_postings");
  db.exec("ALTER TABLE qbo_postings_old RENAME TO qbo_postings");
  db.exec("PRAGMA foreign_keys = ON");
}

/** The pre-6A-1 shape of the two tables that slice rebuilt, plus 6B-1's column. */
function downgrade(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  // 6B-1: earning_endpoints predates `label`. Both the index and the column go,
  // in that order — the index depends on the column.
  db.exec("DROP INDEX IF EXISTS earning_endpoints_label_idx");
  const endpointColumns = (
    db.prepare("PRAGMA table_info('earning_endpoints')").all() as unknown as { name: string }[]
  ).map((c) => c.name);
  if (endpointColumns.includes("label")) {
    db.exec("ALTER TABLE earning_endpoints DROP COLUMN label");
  }
  // qbo_config as it was BEFORE the currency and revenue columns existed, so
  // booting takes the ALTER TABLE path rather than the CREATE path. Without
  // this the shape comparison below compares a fresh table to itself and passes
  // while checking nothing — the same "zero against zero" trap the earn
  // conservation check is in until a receipt exists.
  //
  // `rollup_grain` is left at 'vendor_day' here so the grain rewrite has
  // something to rewrite.
  // EXACTLY THE SHAPE A REAL MIGRATED DATABASE IS IN: the original seven
  // columns with their CHECKs, then the four that arrived later by ALTER TABLE
  // — appended at the end, and carrying NO constraints, because ADD COLUMN
  // cannot attach one. That mismatch between the declared DDL and the real
  // table is the whole hazard 6B-1's rebuild has to survive, and it is only
  // reproducible by building the table this way.
  db.exec("DROP TABLE IF EXISTS qbo_config_old");
  db.exec(`
    CREATE TABLE qbo_config_old (
      company_id            TEXT PRIMARY KEY REFERENCES companies(id),
      expense_account_id    TEXT,
      suspense_account_id   TEXT,
      contra_account_id     TEXT,
      contra_account_kind   TEXT NOT NULL DEFAULT 'prepaid_asset'
                            CHECK (contra_account_kind IN ('prepaid_asset', 'cash', 'clearing')),
      rollup_grain          TEXT NOT NULL DEFAULT 'daily'
                            CHECK (rollup_grain IN ('daily', 'vendor_day')),
      updated_at            TEXT NOT NULL,
      accounting_currency   TEXT,
      currency_source       TEXT,
      currency_checked_at   TEXT,
      revenue_account_id    TEXT
    )
  `);
  db.exec("DROP TABLE IF EXISTS qbo_config");
  db.exec("ALTER TABLE qbo_config_old RENAME TO qbo_config");

  // qbo_postings as it was before 7A-3 recorded which books a document went
  // to (and before its write-off columns), so booting takes the add paths.
  db.exec("DELETE FROM qbo_postings");
  rebuildPostingsAs(db, "pre-7A-3");
  db.exec("PRAGMA foreign_keys = OFF");

  // qbo_posting_drafts as it was before direction existed and while the grain
  // and the column still said "vendor". Safe to drop and recreate here only
  // because foreign keys are off and qbo_postings is seeded afterwards.
  db.exec("DROP TABLE IF EXISTS qbo_posting_drafts");
  db.exec(`
    CREATE TABLE qbo_posting_drafts (
      id            TEXT PRIMARY KEY,
      company_id    TEXT NOT NULL REFERENCES companies(id),
      grain         TEXT NOT NULL CHECK (grain IN ('daily', 'vendor_day')),
      posting_day   TEXT NOT NULL,
      vendor_host   TEXT,
      doc_number    TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      payload_hash  TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('previewed', 'posted', 'superseded', 'discarded')),
      created_at    TEXT NOT NULL
    )
  `);

  db.exec("DROP TABLE IF EXISTS export_postings");
  db.exec("DROP TABLE IF EXISTS posting_lines");
  db.exec(`
    CREATE TABLE posting_lines (
      id                  TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL,
      agent_id            TEXT NOT NULL REFERENCES agents(id),
      vendor_host         TEXT NOT NULL,
      posting_day         TEXT NOT NULL,
      ledger_class        TEXT NOT NULL CHECK (ledger_class IN ('expense', 'suspense')),
      amount_base_units   INTEGER NOT NULL,
      created_at          TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE export_postings (
      payment_id          TEXT NOT NULL REFERENCES payments(id),
      line_id             TEXT NOT NULL REFERENCES posting_lines(id),
      absorbed_base_units INTEGER NOT NULL,
      PRIMARY KEY (payment_id, line_id)
    )
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "fuel-migration-"));
  const dbPath = join(dir, "scratch.db");

  console.log("== building a database, then putting it back into the old shape ==");
  boot(dbPath);

  let db = new DatabaseSync(dbPath);
  const now = new Date().toISOString();

  // Real parent rows, so the post-migration foreign_key_check is a genuine test
  // rather than one that passes because nothing referenced anything.
  const team = db.prepare("SELECT id FROM teams LIMIT 1").get() as { id: string };
  db.prepare(
    `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                         spend_cap_base_units, created_at)
     VALUES ('agent-1', 'migration-test', ?, 'v1', '0xabc', 1000000, ?)`,
  ).run(team.id, now);
  db.prepare(
    `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, created_at)
     VALUES ('pay-1', 'agent-1', 25000, 'https://api.example.com/x', 'settled', ?)`,
  ).run(now);

  downgrade(db);

  db.prepare(
    `INSERT INTO posting_lines
       (id, run_id, agent_id, vendor_host, posting_day, ledger_class, amount_base_units, created_at)
     VALUES ('line-1', 'run-1', 'agent-1', 'api.example.com', '2026-09-01', 'expense', 20000, ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO export_postings (payment_id, line_id, absorbed_base_units)
     VALUES ('pay-1', 'line-1', 20000)`,
  ).run();

  // THREE ENDPOINTS ON ONE AGENT, TWO OF THEM SHARING AN ORIGIN. This is the
  // case that breaks a naive backfill: origin_url has no uniqueness constraint,
  // so both derive the same label, and CREATE UNIQUE INDEX then fails — at
  // boot, on a customer's database, rather than here. The third has an origin
  // that will not parse, which must still get a name rather than stop the
  // migration.
  const seedEndpoint = (id: string, originUrl: string): void => {
    db.prepare(
      `INSERT INTO earning_endpoints
         (id, agent_id, public_id, origin_url, price_base_units, forward_secret,
          ownership_nonce, enabled, created_at, updated_at)
       VALUES (?, 'agent-1', ?, ?, 1000, 'enc', 'nonce', 0, ?, ?)`,
    ).run(id, `public-${id}`, originUrl, now, now);
  };
  seedEndpoint("ep-1", "https://api.example.com/forecast");
  seedEndpoint("ep-2", "https://api.example.com/forecast");
  seedEndpoint("ep-3", "not a url at all");

  // A qbo_config with real values in the four ALTER-added columns, written
  // AFTER the downgrade so they sit in that table's appended order. This is
  // what makes the rebuild's column mapping testable: a positional copy would
  // scramble these four and every value below would land in the wrong column.
  const companyId = (db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string }).id;

  // A draft at the OLD grain with the OLD column name, and a live `pending`
  // posting referencing it. The posting is the reason ids must be copied
  // verbatim: reissuing them would orphan a posted document from its lines.
  db.prepare(
    `INSERT INTO qbo_posting_drafts
       (id, company_id, grain, posting_day, vendor_host, doc_number,
        payload_json, payload_hash, source_fingerprint, status, created_at)
     VALUES ('draft-1', ?, 'vendor_day', '2026-09-01', 'api.example.com', 'FUEL-abc',
             '{"frozen":true}', 'hash-1', 'fp-1', 'posted', ?)`,
  ).run(companyId, now);
  db.prepare(
    `INSERT INTO qbo_postings
       (id, company_id, draft_id, doc_number, request_id, status, created_at)
     VALUES ('posting-1', ?, 'draft-1', 'FUEL-abc', 'req-1', 'pending', ?)`,
  ).run(companyId, now);
  db.prepare(
    `INSERT INTO qbo_config
       (company_id, expense_account_id, suspense_account_id, contra_account_id,
        contra_account_kind, rollup_grain, updated_at,
        accounting_currency, currency_source, currency_checked_at, revenue_account_id)
     VALUES (?, 'exp-1', 'sus-1', 'contra-1', 'prepaid_asset', 'vendor_day', ?,
             'USD', 'quickbooks_preferences', ?, 'seeded-revenue-account')`,
  ).run(companyId, now, now);
  // The company is connected, so the one-time backfill has books to attribute
  // the legacy draft, posting and account mapping to. Token columns hold
  // placeholders: nothing in a boot decrypts them.
  db.prepare(
    `INSERT INTO qbo_connections (id, company_id, realm_id, access_token_enc, access_expires_at,
                                  refresh_token_enc, refresh_expires_at, connected_at, updated_at)
     VALUES ('conn-legacy', ?, 'realm-legacy', 'enc', ?, 'enc', ?, ?, ?)`,
  ).run(companyId, now, now, now, now);
  db.close();

  console.log("\n== migrating ==");
  const log = boot(dbPath);
  check("migration announced posting_lines", /migrated posting_lines/.test(log));
  check("migration announced export_postings", /migrated export_postings/.test(log));

  db = new DatabaseSync(dbPath);

  console.log("\n== the data survived ==");
  const line = db.prepare("SELECT * FROM posting_lines WHERE id = 'line-1'").get() as Record<
    string,
    unknown
  >;
  check("the line is still there", line !== undefined);
  check(
    "vendor_host carried over into counterparty verbatim",
    line.counterparty === "api.example.com",
    String(line.counterparty),
  );
  check("its amount is unchanged", Number(line.amount_base_units) === 20000);
  check("its class is unchanged", line.ledger_class === "expense");

  const absorption = db.prepare("SELECT * FROM export_postings").get() as Record<string, unknown>;
  check("the absorption is still there", absorption !== undefined);
  check("it still names its payment", absorption.payment_id === "pay-1");
  check("and names no receipt", absorption.receipt_id === null);

  console.log("\n== every endpoint got a name, including the ones that collide ==");
  const labelled = db
    .prepare("SELECT id, label FROM earning_endpoints ORDER BY id")
    .all() as unknown as { id: string; label: string }[];
  check("all three endpoints have a label", labelled.every((e) => !!e.label), JSON.stringify(labelled));
  check(
    "the first takes the derived name",
    labelled[0]?.label === "api.example.com/forecast",
    String(labelled[0]?.label),
  );
  check(
    "the second, which would have collided, is disambiguated rather than refused",
    labelled[1]?.label === "api.example.com/forecast (2)",
    String(labelled[1]?.label),
  );
  check(
    "an unparseable origin still gets a name rather than blocking the migration",
    labelled[2]?.label === "endpoint",
    String(labelled[2]?.label),
  );
  throws(
    "and the unique index now holds, which is what the disambiguation was for",
    () =>
      db
        .prepare("UPDATE earning_endpoints SET label = 'api.example.com/forecast' WHERE id = 'ep-2'")
        .run(),
    /UNIQUE constraint failed/,
  );

  console.log("\n== qbo_config's declared shape and its migrated shape are the same ==");
  {
    // THE PRECONDITION FOR EVER REBUILDING THIS TABLE. Its CREATE TABLE text
    // describes a fresh database; four columns arrive on an existing one by
    // ALTER TABLE instead. A rebuild written against the declared text would
    // silently drop a live company's verified currency and income account.
    //
    // Asserting the two shapes agree is what makes the factory worth extracting:
    // if someone adds a fifth column by ALTER and forgets the DDL, this fails
    // here rather than during a migration on a customer's database.
    const freshPath = join(dir, "fresh.db");
    boot(freshPath);
    const fresh = new DatabaseSync(freshPath);
    const declared = (
      fresh.prepare("PRAGMA table_info('qbo_config')").all() as unknown as { name: string }[]
    ).map((c) => c.name);
    fresh.close();

    const migrated = (
      db.prepare("PRAGMA table_info('qbo_config')").all() as unknown as { name: string }[]
    ).map((c) => c.name);

    // Proves the checks below are not vacuous: this database really was
    // rebuilt, from a table in the appended ALTER TABLE order.
    check(
      "qbo_config was rebuilt rather than created fresh",
      /migrated qbo_config: rollup_grain now daily\/counterparty_day/.test(log),
      "downgrade() must leave qbo_config in its pre-rebuild shape",
    );

    check(
      "a freshly created qbo_config and a migrated one hold the same set of columns",
      declared.length === migrated.length &&
        [...declared].sort().every((c, i) => c === [...migrated].sort()[i]),
      `declared=${declared.join(",")} migrated=${migrated.join(",")}`,
    );

    // THE VALUES LANDED IN THE RIGHT COLUMNS, which is what the ordering
    // difference actually threatened and what an ordering assertion could only
    // gesture at.
    //
    // Before the rebuild these four columns sit in ALTER TABLE's appended order
    // and the declared table puts revenue_account_id fifth. A rebuild using
    // `INSERT INTO new SELECT * FROM old` maps positionally, so it would write
    // this company's revenue_account_id into contra_account_kind — both TEXT,
    // no complaint, wrong data. Seeded through the ALTER path above and read
    // back by NAME here, so a positional copy fails this rather than passing it.
    const config = db.prepare("SELECT * FROM qbo_config WHERE company_id = ?").get(companyId) as
      | Record<string, unknown>
      | undefined;
    check("the config row survived the rebuild", config !== undefined);
    check(
      "revenue_account_id still holds an account id, not a contra kind",
      config?.revenue_account_id === "seeded-revenue-account",
      String(config?.revenue_account_id),
    );
    check(
      "accounting_currency still holds a currency",
      config?.accounting_currency === "USD",
      String(config?.accounting_currency),
    );
    check(
      "currency_source still holds its evidence",
      config?.currency_source === "quickbooks_preferences",
      String(config?.currency_source),
    );
    check(
      "contra_account_kind was not overwritten by a neighbouring column",
      config?.contra_account_kind === "prepaid_asset",
      String(config?.contra_account_kind),
    );

    // And the grain rewrote rather than being dropped or left invalid.
    check(
      "an existing vendor_day config became counterparty_day",
      config?.rollup_grain === "counterparty_day",
      String(config?.rollup_grain),
    );
    throws(
      "and the widened CHECK still refuses a grain that is neither",
      () =>
        db
          .prepare("UPDATE qbo_config SET rollup_grain = 'nonsense' WHERE company_id = ?")
          .run(companyId),
      /CHECK constraint failed/,
    );

    // The CHECK that ALTER TABLE could never attach is now real. It was
    // declared in the DDL from the start and had never once reached a migrated
    // database.
    throws(
      "currency_source is constrained for the first time on a migrated database",
      () =>
        db
          .prepare("UPDATE qbo_config SET currency_source = 'operator_guess' WHERE company_id = ?")
          .run(companyId),
      /CHECK constraint failed/,
    );
    for (const column of [
      "accounting_currency",
      "currency_source",
      "currency_checked_at",
      "revenue_account_id",
    ]) {
      check(`and both carry ${column}, which only ALTER TABLE ever added`, declared.includes(column));
    }
  }

  console.log("\n== the drafts rebuild: direction added, two renames, drafts intact ==");
  {
    const draft = db
      .prepare("SELECT * FROM qbo_posting_drafts WHERE id = 'draft-1'")
      .get() as Record<string, unknown> | undefined;
    check("the draft survived the rebuild", draft !== undefined);
    check(
      "vendor_host carried over into counterparty verbatim",
      draft?.counterparty === "api.example.com",
      String(draft?.counterparty),
    );
    check(
      "its grain was rewritten, not dropped",
      draft?.grain === "counterparty_day",
      String(draft?.grain),
    );
    check(
      "and it is a spend draft — no revenue line could exist when it was written",
      draft?.direction === "spend",
      String(draft?.direction),
    );
    check("its frozen payload is byte-identical", draft?.payload_json === '{"frozen":true}');
    check("and its hash was not recomputed", draft?.payload_hash === "hash-1");

    // THE REASON THE ID IS COPIED VERBATIM. A qbo_postings row references this
    // draft; if the rebuild had reissued ids, a posted document would have been
    // orphaned from the lines it covers — the trail an operator reconciles
    // against, silently cut.
    const posting = db
      .prepare("SELECT draft_id, status FROM qbo_postings WHERE id = 'posting-1'")
      .get() as { draft_id: string; status: string } | undefined;
    check("a live pending posting still points at its draft", posting?.draft_id === "draft-1");
    check("and is still pending — nothing about its state was touched", posting?.status === "pending");

    throws(
      "the widened grain CHECK still refuses an unknown grain",
      () =>
        db.prepare("UPDATE qbo_posting_drafts SET grain = 'nonsense' WHERE id = 'draft-1'").run(),
      /CHECK constraint failed/,
    );
    throws(
      "and direction is closed to two values, not free text",
      () =>
        db
          .prepare("UPDATE qbo_posting_drafts SET direction = 'sideways' WHERE id = 'draft-1'")
          .run(),
      /CHECK constraint failed/,
    );
    db.prepare("UPDATE qbo_posting_drafts SET direction = 'earn' WHERE id = 'draft-1'").run();
    check("but 'earn' is accepted", true);
    db.prepare("UPDATE qbo_posting_drafts SET direction = 'spend' WHERE id = 'draft-1'").run();
  }

  console.log("\n== the rebuilds and the new column agree on which books everything belongs to ==");
  {
    /*
     * The drafts and config tables reach 7A-3's column through their OWN
     * one-time rebuilds, which create it from the factory -- so the add-column
     * step sees it already there and does nothing. If those rebuilds left it
     * NULL, an old database would come out with postings attributed and their
     * drafts and account mapping not: one history, two answers, decided by
     * how old the database happened to be.
     */
    const draft = db.prepare("SELECT realm_id FROM qbo_posting_drafts WHERE id = 'draft-1'").get() as
      | { realm_id: string | null }
      | undefined;
    const posting = db.prepare("SELECT realm_id FROM qbo_postings WHERE id = 'posting-1'").get() as
      | { realm_id: string | null }
      | undefined;
    const config = db
      .prepare("SELECT accounts_realm_id FROM qbo_config WHERE company_id = ?")
      .get(companyId) as { accounts_realm_id: string | null } | undefined;
    check(
      "the rebuilt draft is attributed to the connected books",
      draft?.realm_id === "realm-legacy",
      String(draft?.realm_id),
    );
    check(
      "the rebuilt account mapping is attributed to them too",
      config?.accounts_realm_id === "realm-legacy",
      String(config?.accounts_realm_id),
    );
    check(
      "and the posting, which took the add-column path, agrees",
      posting?.realm_id === "realm-legacy",
      String(posting?.realm_id),
    );
  }

  console.log("\n== the old column names are gone, not merely shadowed ==");
  const columns = (
    db.prepare("PRAGMA table_info('posting_lines')").all() as unknown as { name: string }[]
  ).map((c) => c.name);
  check("posting_lines has counterparty", columns.includes("counterparty"));
  check("posting_lines has no vendor_host", !columns.includes("vendor_host"));

  console.log("\n== the widened CHECK actually accepts revenue ==");
  db.prepare(
    `INSERT INTO posting_lines
       (id, run_id, agent_id, counterparty, posting_day, ledger_class, amount_base_units, created_at)
     VALUES ('line-rev', 'run-1', 'agent-1', 'endpoint-7', '2026-09-01', 'revenue', 30000, ?)`,
  ).run(now);
  check("a revenue line inserts", true);
  throws(
    "an unknown class is still refused",
    () =>
      db
        .prepare(
          `INSERT INTO posting_lines
             (id, run_id, agent_id, counterparty, posting_day, ledger_class, amount_base_units, created_at)
           VALUES ('line-bad', 'run-1', 'agent-1', 'x', '2026-09-01', 'nonsense', 1, ?)`,
        )
        .run(now),
    /CHECK constraint failed/,
  );

  console.log("\n== exactly one source, enforced ==");
  db.prepare(
    `INSERT INTO receipts (id, agent_id, amount_base_units, status,
                           payer_address, authorization_nonce, created_at)
     VALUES ('rec-1', 'agent-1', 30000, 'settled', '0xpayer', '0xnonce-1', ?)`,
  ).run(now);
  throws(
    "an absorption naming neither source is refused",
    () =>
      db
        .prepare(
          "INSERT INTO export_postings (payment_id, receipt_id, line_id, absorbed_base_units) VALUES (NULL, NULL, 'line-rev', 1)",
        )
        .run(),
    /CHECK constraint failed/,
  );
  throws(
    "an absorption naming both sources is refused",
    () =>
      db
        .prepare(
          "INSERT INTO export_postings (payment_id, receipt_id, line_id, absorbed_base_units) VALUES ('pay-1', 'rec-1', 'line-rev', 1)",
        )
        .run(),
    /CHECK constraint failed/,
  );

  console.log("\n== duplicate absorption, the check the old primary key would have lost ==");
  throws(
    "the same payment cannot be absorbed twice by one line",
    () =>
      db
        .prepare(
          "INSERT INTO export_postings (payment_id, receipt_id, line_id, absorbed_base_units) VALUES ('pay-1', NULL, 'line-1', 1)",
        )
        .run(),
    /UNIQUE constraint failed/,
  );

  // THE ONE THAT MATTERS. Under a nullable `PRIMARY KEY (payment_id, line_id)`
  // every receipt row has payment_id NULL, and SQLite treats NULLs as distinct
  // in a primary key — so this insert would have SUCCEEDED, twice, and the same
  // receipt would have been absorbed twice into one line with nothing
  // complaining. The partial index on (receipt_id, line_id) is what closes it.
  db.prepare(
    "INSERT INTO export_postings (payment_id, receipt_id, line_id, absorbed_base_units) VALUES (NULL, 'rec-1', 'line-rev', 30000)",
  ).run();
  throws(
    "the same RECEIPT cannot be absorbed twice by one line",
    () =>
      db
        .prepare(
          "INSERT INTO export_postings (payment_id, receipt_id, line_id, absorbed_base_units) VALUES (NULL, 'rec-1', 'line-rev', 1)",
        )
        .run(),
    /UNIQUE constraint failed/,
  );

  console.log("\n== nothing dangles ==");
  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  check("no foreign key violations after migrating", violations.length === 0, `${violations.length}`);

  console.log("\n== the migration is idempotent ==");
  const before = db.prepare("SELECT COUNT(*) AS n FROM export_postings").get() as { n: number };
  // Alerting (ADR 0021) adds five tables on every boot with IF NOT EXISTS. A
  // row written before a reboot must still be there after it.
  db.prepare("INSERT OR REPLACE INTO alert_state (id, last_sweep_at) VALUES (1, 'survives-reboot')").run();
  db.close();
  const secondLog = boot(dbPath);
  check("a second boot re-migrates nothing", !/migrated posting_lines/.test(secondLog));
  check("and rebuilds export_postings no further", !/migrated export_postings/.test(secondLog));
  db = new DatabaseSync(dbPath);
  const after = db.prepare("SELECT COUNT(*) AS n FROM export_postings").get() as { n: number };
  check("row count is untouched by the second boot", Number(after.n) === Number(before.n));
  const alertState = db.prepare("SELECT last_sweep_at FROM alert_state WHERE id = 1").get() as { last_sweep_at: string };
  check("AL-M1: an alert row written before a reboot survives it", alertState.last_sweep_at === "survives-reboot");
  const alertTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'alert_%' ORDER BY name")
    .all() as { name: string }[];
  check(
    "AL-M1: all five alert tables exist",
    alertTables.map((t) => t.name).join(",") === "alert_deliveries,alert_events,alert_state,alert_webhook_changes,alert_webhooks",
  );
  const dedupe = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'alert_events_open_uniq'")
    .get() as { sql: string } | undefined;
  check("AL-M1: the dedupe index exists, partial on open rows", dedupe !== undefined && /WHERE resolved_at IS NULL/.test(dedupe.sql));
  db.close();

  verifyBootstrapBinding(dir);
  verifyAgentConstraints(dir);
  verifyQuickBooksUniqueness(dir);
  verifyRealmBackfill(dir);
  verifyWriteOffColumns(dir);
  verifyOAuthStateStarter(dir);
  verifyCompanyScopedAccounts(dir);
  verifyIdentityTables(dir);
  await verifyInviteRaceAcrossProcesses(dir);
  await verifyFoundingInviteRaceAcrossProcesses(dir);
  await verifyDecisionRaceAcrossProcesses(dir);
  await verifyPostingRaceAcrossProcesses(dir);

  console.log(`\nAll ${checks} checks passed.`);
  console.log(`Scratch database: ${dbPath} (fuel.db was never opened)`);
}

/**
 * Loads the credential resolver against a database, the way the server does.
 *
 * A child process, for the reason `boot` is one: src/lib/auth.ts resolves the
 * bootstrap company at MODULE LOAD, so the only faithful test of "does the
 * server refuse to start" is actually starting a process. Keys are fixed test
 * values; nothing here reaches a provider.
 */
function loadAuth(dbPath: string): { ok: true; out: string } | { ok: false; err: string } {
  try {
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--no-warnings",
        "-e",
        // Prints WHICH company the resolver bound, not merely that it loaded.
        // "It loaded" passes just as well for a resolver that silently picked
        // the wrong tenant — which is the failure this whole binding exists to
        // prevent, and the first draft of this test could not see it.
        'import("./src/lib/auth.ts").then(() => import("./src/db/companies.ts")).then((m) => console.log("BOUND=" + m.bootstrapCompany().id));',
      ],
      {
        env: {
          ...process.env,
          FUEL_DB_PATH: dbPath,
          FUEL_API_KEY: "migration-test-operator",
          FUEL_AGENT_KEY: "migration-test-agent",
        },
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    return { ok: true, out };
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    return { ok: false, err: `${e.stderr ?? ""}${e.message}` };
  }
}

/**
 * 7A-1: the legacy credentials act for a company that is RECORDED, never
 * guessed.
 *
 * `getDefaultCompany()` answered "which company?" with "the oldest one", which
 * never errors and is wrong the moment a second company exists. These three
 * scenarios are the three states a real database can be in when this code
 * first meets it.
 */
function verifyBootstrapBinding(dir: string): void {
  console.log("\n== the bootstrap company is recorded once, never guessed ==");
  const insertCompany = (db: DatabaseSync, id: string, name: string, createdAt: string) =>
    db
      .prepare("INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES (?, ?, 0, ?)")
      .run(id, name, createdAt);
  const boundTo = (db: DatabaseSync) =>
    (db.prepare("SELECT company_id FROM bootstrap_company WHERE id = 1").get() as
      | { company_id: string }
      | undefined)?.company_id;

  // 1. A fresh install: one seeded company, recorded on first boot.
  const freshPath = join(dir, "bootstrap-fresh.db");
  const freshLog = boot(freshPath);
  let db = new DatabaseSync(freshPath);
  const seeded = db.prepare("SELECT id FROM companies").all() as unknown as { id: string }[];
  check("a fresh install seeds exactly one company", seeded.length === 1);
  check("and records it as the bootstrap company", boundTo(db) === seeded[0]!.id);
  check("saying so in the boot log", /recorded the bootstrap company/.test(freshLog));
  db.close();
  check("the credential resolver loads against it", loadAuth(freshPath).ok);

  // 2. THE BINDING SURVIVES A SECOND COMPANY. This is the case the old code got
  //    silently wrong, and the reason the answer is written down at all: once a
  //    second company exists, "the only company" stops being derivable.
  db = new DatabaseSync(freshPath);
  // Created EARLIER than the real one, so "oldest company" — the old rule —
  // would pick the wrong tenant. A binding that merely re-derived the answer
  // would follow it; a recorded one must not.
  insertCompany(db, "older-intruder", "Older Intruder Co", "2000-01-01T00:00:00.000Z");
  db.close();
  const secondBoot = boot(freshPath);
  db = new DatabaseSync(freshPath);
  check("a second company does not move the binding", boundTo(db) === seeded[0]!.id);
  check("even one created earlier, which 'oldest company' would have picked", boundTo(db) !== "older-intruder");
  check("and a later boot does not re-record anything", !/recorded the bootstrap company/.test(secondBoot));
  db.close();
  const withTwo = loadAuth(freshPath);
  check("the resolver still loads with two companies and a recorded binding", withTwo.ok);
  /*
   * THE CHECK ABOVE IS NOT ENOUGH, and a break test proved it: replacing
   * bootstrapCompany() with "the oldest company" left every check in this
   * scenario passing, because they read the table directly and never asked the
   * function the server actually calls. Loading proves nothing about WHOM it
   * loaded for.
   */
  check(
    "and it binds the RECORDED company, not the older one 'oldest company' would pick",
    withTwo.ok && withTwo.out.includes(`BOUND=${seeded[0]!.id}`) && !withTwo.out.includes("BOUND=older-intruder"),
    withTwo.ok ? withTwo.out.trim() : withTwo.err.slice(0, 200),
  );

  // 3. AN EXISTING MULTI-COMPANY DATABASE WITH NO BINDING. There is no honest
  //    answer, so there must be no answer: the migration records nothing and
  //    the server refuses to start rather than picking a tenant.
  db = new DatabaseSync(freshPath);
  db.exec("DROP TABLE bootstrap_company");
  db.close();
  const ambiguousBoot = boot(freshPath);
  db = new DatabaseSync(freshPath);
  check("with two companies and no binding, the migration records nothing", boundTo(db) === undefined);
  check("and says nothing about recording one", !/recorded the bootstrap company/.test(ambiguousBoot));
  db.close();
  const refused = loadAuth(freshPath);
  check("and the credential resolver REFUSES TO LOAD", !refused.ok);
  check(
    "with a message naming the ambiguity rather than a stack trace about undefined",
    !refused.ok && /No bootstrap company is recorded, and this database holds 2 companies/.test(refused.err),
    refused.ok ? "loaded" : refused.err.slice(0, 300),
  );
}

/** Boots, reporting a refusal as data instead of throwing it. */
function tryBoot(dbPath: string): { ok: true; out: string } | { ok: false; err: string } {
  try {
    return { ok: true, out: boot(dbPath) };
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    return { ok: false, err: `${e.stderr ?? ""}${e.message}` };
  }
}

/**
 * Puts `agents` back into its pre-7A-1 shape: name globally UNIQUE (or, with
 * `nameUnique: false`, not unique at all), and nothing stopping two agents
 * sharing a vault. Every column named, so the copy cannot map positionally.
 */
function downgradeAgents(db: DatabaseSync, { nameUnique }: { nameUnique: boolean }): void {
  const columns =
    "id, name, team_id, fireblocks_vault_id, address, spend_cap_base_units, created_at, " +
    "frozen_at, frozen_reason, frozen_attempt_count, last_frozen_attempt_at";
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE agents_old (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL${nameUnique ? " UNIQUE" : ""},
      team_id              TEXT NOT NULL REFERENCES teams(id),
      fireblocks_vault_id  TEXT NOT NULL,
      address              TEXT NOT NULL,
      spend_cap_base_units INTEGER NOT NULL,
      created_at           TEXT NOT NULL,
      frozen_at            TEXT,
      frozen_reason        TEXT,
      frozen_attempt_count INTEGER NOT NULL DEFAULT 0,
      last_frozen_attempt_at TEXT
    )
  `);
  db.exec(`INSERT INTO agents_old (${columns}) SELECT ${columns} FROM agents`);
  db.exec("DROP TABLE agents");
  db.exec("ALTER TABLE agents_old RENAME TO agents");
  db.exec("CREATE INDEX IF NOT EXISTS agents_team_idx ON agents(team_id)");
  db.exec("PRAGMA foreign_keys = ON");
}

/** The column list of every non-partial UNIQUE index on agents, e.g. "team_id,name". */
function agentUniqueSets(db: DatabaseSync): string[] {
  const indexes = db.prepare("PRAGMA index_list('agents')").all() as unknown as {
    name: string;
    unique: number;
    partial: number;
  }[];
  return indexes
    .filter((i) => Number(i.unique) === 1 && Number(i.partial) === 0)
    .map((i) =>
      (db.prepare(`PRAGMA index_info('${i.name}')`).all() as unknown as { seqno: number; name: string }[])
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((c) => c.name)
        .join(","),
    )
    .sort();
}

const hashOf = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * 7A-1: agent names unique per team, one agent per vault.
 *
 * The constraint alone is easy. What this proves is the migration a REAL
 * database takes to reach it -- every row and reference carried over, the
 * index set actually changed -- and that a database it cannot honestly migrate
 * is refused by name rather than "fixed" by guessing which agent keeps a vault.
 */
function verifyAgentConstraints(dir: string): void {
  const insertAgent = (
    db: DatabaseSync,
    row: { id: string; name: string; team: string; vault: string; address?: string },
  ) =>
    db
      .prepare(
        `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address, spend_cap_base_units, created_at)
         VALUES (?, ?, ?, ?, ?, 123456, '2026-08-01T00:00:00.000Z')`,
      )
      .run(row.id, row.name, row.team, row.vault, row.address ?? "0xagent");
  const addTeam = (db: DatabaseSync, id: string) => {
    const company = (db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string }).id;
    db.prepare(
      "INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at) VALUES (?, ?, ?, 0, '2026-08-01T00:00:00.000Z')",
    ).run(id, company, `Team ${id}`);
  };
  const seededTeam = (db: DatabaseSync) =>
    (db.prepare("SELECT id FROM teams ORDER BY created_at LIMIT 1").get() as { id: string }).id;

  console.log("\n== agents: the rebuild carries every row and reference ==");
  {
    const path = join(dir, "agents-rebuild.db");
    boot(path);
    let db = new DatabaseSync(path);
    const team = seededTeam(db);
    addTeam(db, "team-2");
    downgradeAgents(db, { nameUnique: true });
    check(
      "the downgrade really restored the old constraint set, so the rebuild below is not vacuous",
      agentUniqueSets(db).includes("name") &&
        !agentUniqueSets(db).includes("team_id,name") &&
        !agentUniqueSets(db).includes("fireblocks_vault_id"),
      agentUniqueSets(db).join(" | "),
    );
    insertAgent(db, { id: "agent-a", name: "alpha", team, vault: "vault-a" });
    insertAgent(db, { id: "agent-b", name: "beta", team: "team-2", vault: "vault-b" });
    db.prepare(
      "UPDATE agents SET frozen_at = '2026-08-02T00:00:00.000Z', frozen_reason = 'held', frozen_attempt_count = 3, last_frozen_attempt_at = '2026-08-03T00:00:00.000Z' WHERE id = 'agent-a'",
    ).run();
    db.prepare(
      "INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, created_at) VALUES ('pay-a', 'agent-a', 1000, 'https://x.test/', 'settled', '2026-08-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      `INSERT INTO earning_endpoints (id, agent_id, public_id, origin_url, label, price_base_units, forward_secret, ownership_nonce, enabled, created_at, updated_at)
       VALUES ('ep-b', 'agent-b', 'pub-b', 'https://origin.test/', 'origin.test', 1000, 'enc', 'nonce', 0, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run();
    const rowsBefore = JSON.stringify(db.prepare("SELECT * FROM agents ORDER BY id").all());
    db.close();

    const log = boot(path);
    check("the boot announces the agents migration", /migrated agents: names unique per team, one agent per vault/.test(log), log);
    db = new DatabaseSync(path);
    check(
      "every agent row is byte-for-byte what it was, freeze state included",
      JSON.stringify(db.prepare("SELECT * FROM agents ORDER BY id").all()) === rowsBefore,
    );
    check(
      "the unique constraints are now per-team names and per-agent vaults, and name alone is not one",
      agentUniqueSets(db).includes("team_id,name") &&
        agentUniqueSets(db).includes("fireblocks_vault_id") &&
        !agentUniqueSets(db).includes("name"),
      agentUniqueSets(db).join(" | "),
    );
    check(
      "the team index survived the rebuild",
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'agents_team_idx'").get(),
    );
    check("no foreign key dangles: the payment and the endpoint still find their agents", (db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length === 0);
    check("foreign key enforcement is back on", Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys) === 1);

    insertAgent(db, { id: "agent-c", name: "alpha", team: "team-2", vault: "vault-c" });
    check("the same name in another team is accepted", true);
    throws(
      "the same name twice in one team is refused",
      () => insertAgent(db, { id: "agent-d", name: "alpha", team, vault: "vault-d" }),
      /UNIQUE constraint failed: agents\.team_id, agents\.name/,
    );
    throws(
      "a second agent on a held vault is refused",
      () => insertAgent(db, { id: "agent-e", name: "epsilon", team, vault: "vault-a" }),
      /UNIQUE constraint failed: agents\.fireblocks_vault_id/,
    );
    db.close();
    check("a second boot does not rebuild again", !/migrated agents:/.test(boot(path)));
  }

  console.log("\n== agents: what the migration will not decide, it refuses ==");
  {
    const path = join(dir, "agents-shared-vault.db");
    boot(path);
    let db = new DatabaseSync(path);
    const team = seededTeam(db);
    downgradeAgents(db, { nameUnique: true });
    insertAgent(db, { id: "keeper", name: "keeper", team, vault: "shared" });
    insertAgent(db, { id: "sharer", name: "sharer", team, vault: "shared" });
    db.close();
    const refused = tryBoot(path);
    check("a database with two agents on one vault does not boot", !refused.ok);
    check(
      "and the refusal names the vault and both agents",
      !refused.ok && /Refusing to migrate agents: vault shared is held by more than one agent \((keeper, sharer|sharer, keeper)\)/.test(refused.err),
      refused.ok ? "booted" : refused.err.slice(0, 300),
    );
    db = new DatabaseSync(path);
    check("and changed nothing: the old constraint set is still in place", agentUniqueSets(db).includes("name") && !agentUniqueSets(db).includes("fireblocks_vault_id"));
    check("and both agents still hold the vault they held", Number((db.prepare("SELECT COUNT(*) AS n FROM agents WHERE fireblocks_vault_id = 'shared'").get() as { n: number }).n) === 2);
    db.close();
  }
  {
    const path = join(dir, "agents-name-clash.db");
    boot(path);
    let db = new DatabaseSync(path);
    const team = seededTeam(db);
    downgradeAgents(db, { nameUnique: false });
    insertAgent(db, { id: "twin-1", name: "twin", team, vault: "vault-1" });
    insertAgent(db, { id: "twin-2", name: "twin", team, vault: "vault-2" });
    db.close();
    const refused = tryBoot(path);
    check(
      "two same-named agents in one team are refused by name, not renamed",
      !refused.ok && /has more than one agent with the same name \((twin-1, twin-2|twin-2, twin-1)\)/.test(refused.err),
      refused.ok ? "booted" : refused.err.slice(0, 300),
    );
    db = new DatabaseSync(path);
    check("and neither was renamed", Number((db.prepare("SELECT COUNT(*) AS n FROM agents WHERE name = 'twin'").get() as { n: number }).n) === 2);
    db.close();
  }

  console.log("\n== the repair script: reports, refuses, and is a no-op once done (never --confirm here) ==");
  {
    const HOLDER = "80081c73-9426-4406-b7b2-8e11670f40d3";
    const FIXTURE = "d6f29943-241d-4874-a0a2-9a21f7c7ebb0";
    const runScript = (dbPath: string): { ok: boolean; out: string } => {
      try {
        const out = execFileSync(
          process.execPath,
          ["--import", "tsx", "--no-warnings", "scripts/remediate-shared-vault.ts"],
          {
            // No credentials in reach: a dry run must not need them, and if the
            // script ever tried the network anyway it would fail here, loudly.
            env: { ...process.env, FUEL_DB_PATH: dbPath, FIREBLOCKS_API_KEY: "", FIREBLOCKS_PRIVATE_KEY_PATH: "" },
            encoding: "utf8",
            stdio: "pipe",
          },
        );
        return { ok: true, out };
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; message: string };
        return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    };

    const path = join(dir, "agents-remediation.db");
    boot(path);
    let db = new DatabaseSync(path);
    const team = seededTeam(db);
    downgradeAgents(db, { nameUnique: true });
    insertAgent(db, { id: HOLDER, name: "trap-bot", team, vault: "4", address: "0xshared" });
    insertAgent(db, { id: FIXTURE, name: "empty-balance-test-agent", team, vault: "4", address: "0xshared" });
    db.prepare(
      "INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, created_at) VALUES ('fx-unrec', ?, 1000, 'https://x.test/', 'unreconciled', '2026-08-01T00:00:00.000Z')",
    ).run(FIXTURE);
    db.close();

    const before = hashOf(path);
    const dry = runScript(path);
    check("a dry run against the known shared pair succeeds", dry.ok, dry.out.slice(0, 300));
    check("it says which agent keeps the vault and which moves", /KEEPS IT\s+trap-bot/.test(dry.out) && /MOVES\s+empty-balance-test-agent/.test(dry.out));
    check("and says it made no network call", /Dry run: no network call was made and nothing was written/.test(dry.out));
    check("and the database file is byte-identical afterwards", hashOf(path) === before);

    db = new DatabaseSync(path);
    db.prepare(
      "INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status, created_at) VALUES ('fx-settled', ?, 1000, 'https://x.test/', 'settled', '2026-08-01T00:00:00.000Z')",
    ).run(FIXTURE);
    db.close();
    const refusedSettled = runScript(path);
    check(
      "it refuses to move an agent whose settled history was signed by the shared vault",
      !refusedSettled.ok && /REFUSING: the fixture has settled payments/.test(refusedSettled.out),
      refusedSettled.out.slice(0, 300),
    );
    db = new DatabaseSync(path);
    db.prepare("DELETE FROM payments WHERE id = 'fx-settled'").run();
    insertAgent(db, { id: "third", name: "third", team, vault: "4", address: "0xshared" });
    db.close();
    const refusedThird = runScript(path);
    check(
      "and refuses when the sharing is not exactly the known pair",
      !refusedThird.ok && /REFUSING: vault sharing is not exactly the known pair/.test(refusedThird.out),
      refusedThird.out.slice(0, 300),
    );

    // What --confirm's UPDATE does, applied by hand -- then the script must see
    // nothing to do, and the application must boot.
    db = new DatabaseSync(path);
    db.prepare("DELETE FROM agents WHERE id = 'third'").run();
    db.prepare("UPDATE agents SET fireblocks_vault_id = 'fresh', address = '0xfresh' WHERE id = ? AND fireblocks_vault_id = '4'").run(FIXTURE);
    db.close();
    const noop = runScript(path);
    check("after the repair, a re-run reports nothing to do", noop.ok && /Nothing to do/.test(noop.out), noop.out.slice(0, 300));
    const booted = tryBoot(path);
    check("and the repaired database boots and migrates", booted.ok && /migrated agents:/.test(booted.out), booted.ok ? booted.out : booted.err.slice(0, 300));
  }
}

/**
 * 7A-1: one live QuickBooks attempt per document number, one Fuel company per
 * QuickBooks company. Both are indexes rather than rebuilds, so what needs
 * proving is the pre-flight in front of each -- that an existing clash stops
 * boot by name instead of dying on CREATE UNIQUE INDEX -- and that the partial
 * index is partial.
 */
/**
 * Stage 3's identity tables: they appear on a fresh database, they appear on one
 * that predates them, and they carry the constraints the security argument rests
 * on — because a comment claiming `email` is unique is worth nothing if the
 * index is missing on the installation that has been running for months.
 */
function verifyIdentityTables(dir: string): void {
  console.log("\n== users and sessions ==");

  const path = join(dir, "identity.db");
  copyFileSync(join(dir, "scratch.db"), path);

  // The pre-Stage-3 shape: a database that has never seen these tables.
  {
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE IF EXISTS invites");
    db.exec("DROP TABLE IF EXISTS sessions");
    db.exec("DROP TABLE IF EXISTS users");
    db.close();
  }

  const booted = tryBoot(path);
  check("a database with no identity tables boots", booted.ok, booted.ok ? "" : booted.err);

  const db = new DatabaseSync(path);

  for (const table of ["users", "sessions", "invites"]) {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name: string } | undefined;
    check(`${table} exists after boot`, row?.name === table);
  }

  /*
   * THE UNIQUENESS THAT SIGN-IN DEPENDS ON, since ADR 0018: an address is
   * unique WITHIN A COMPANY. `findUserForLogin` looks up a company handle and an
   * address, and that pair must be one account or the person signing in would
   * land in whichever row SQLite returned first. It must NOT be unique across
   * companies: that was the invite oracle. Read from the index list rather than
   * the DDL text, so a rename or a rebuild cannot fake it.
   */
  {
    const unique = (db.prepare("PRAGMA index_list(users)").all() as unknown as {
      name: string;
      unique: number;
      partial: number;
    }[])
      .filter((i) => i.unique === 1 && i.partial === 0)
      .map((i) =>
        (db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all() as unknown as {
          seqno: number;
          name: string;
        }[])
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => c.name)
          .join(","),
      );
    check("users are UNIQUE on (company_id, email)", unique.includes("company_id,email"), unique.join(" | "));
    check("and NOT on email alone -- an address may have an account at another company", !unique.includes("email"), unique.join(" | "));
  }

  // Both are enforced by SQLite itself, not by the code above it.
  const company = db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string };
  const now = new Date().toISOString();
  const insertUser = (id: string, email: string, role: string) =>
    db
      .prepare(
        `INSERT INTO users (id, company_id, email, password_hash, role, created_at, disabled_at)
         VALUES (?, ?, ?, 'v1.32768.8.1.c2FsdA.aGFzaA', ?, ?, NULL)`,
      )
      .run(id, company.id, email, role, now);

  insertUser("u-1", "person@example.com", "owner");
  throws(
    "a second user in the same company cannot take the same address",
    () => insertUser("u-2", "person@example.com", "operator"),
    /UNIQUE constraint failed: users\.company_id, users\.email/,
  );
  {
    const elsewhere = "company-elsewhere";
    db.prepare(
      "INSERT INTO companies (id, name, handle, spend_cap_base_units, created_at) VALUES (?, ?, ?, 0, ?)",
    ).run(elsewhere, "Elsewhere Inc", "elsewhere-abcd", now);
    db.prepare(
      `INSERT INTO users (id, company_id, email, password_hash, role, created_at, disabled_at)
       VALUES ('u-elsewhere', ?, 'person@example.com', 'v1.32768.8.1.c2FsdA.aGFzaA', 'owner', ?, NULL)`,
    ).run(elsewhere, now);
    check(
      "the same address CAN have an account at another company",
      !!db.prepare("SELECT 1 FROM users WHERE id = 'u-elsewhere'").get(),
    );
  }
  throws(
    "a role outside owner/operator is refused by the database",
    () => insertUser("u-3", "other@example.com", "wizard"),
    /CHECK constraint failed/,
  );
  throws(
    "a user cannot belong to a company that does not exist",
    () =>
      db
        .prepare(
          `INSERT INTO users (id, company_id, email, password_hash, role, created_at, disabled_at)
           VALUES ('u-4', 'no-such-company', 'x@example.com', 'v1.x', 'operator', ?, NULL)`,
        )
        .run(now),
    /FOREIGN KEY constraint failed/,
  );
  throws(
    "a session cannot belong to a user that does not exist",
    () =>
      db
        .prepare(
          `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, revoked_at)
           VALUES ('s-1', 'no-such-user', ?, ?, ?, NULL)`,
        )
        .run(now, now, now),
    /FOREIGN KEY constraint failed/,
  );

  /*
   * THE INVITE CONSTRAINT THAT KEEPS COMPANY CREATION DELIBERATE.
   *
   * A NULL company_id means "redeeming this creates a company", and the first
   * member of a new company has to be an owner — there would otherwise be
   * nobody able to administer it and no way to make one. Enforced by the
   * database, not only by the code that writes the row, because the script and
   * the route are two writers and a third will eventually exist.
   */
  {
    const insertInvite = (id: string, companyId: string | null, role: string) =>
      db
        .prepare(
          `INSERT INTO invites (id, token_hash, company_id, email, role, created_at, expires_at,
                                redeemed_at, redeemed_by, revoked_at)
           VALUES (?, ?, ?, 'x@example.com', ?, ?, ?, NULL, NULL, NULL)`,
        )
        .run(id, `hash-${id}`, companyId, role, now, now);

    insertInvite("i-1", null, "owner");
    throws(
      "a founding invite cannot make its first member a plain operator",
      () => insertInvite("i-2", null, "operator"),
      /CHECK constraint failed/,
    );
    insertInvite("i-3", company.id, "operator");

    throws(
      "two invites cannot share a token hash",
      () =>
        db
          .prepare(
            `INSERT INTO invites (id, token_hash, company_id, email, role, created_at, expires_at,
                                  redeemed_at, redeemed_by, revoked_at)
             VALUES ('i-4', 'hash-i-1', ?, 'y@example.com', 'operator', ?, ?, NULL, NULL, NULL)`,
          )
          .run(company.id, now, now),
      /UNIQUE constraint failed: invites\.token_hash/,
    );
    throws(
      "an invite cannot point at a company that does not exist",
      () => insertInvite("i-5", "no-such-company", "operator"),
      /FOREIGN KEY constraint failed/,
    );
  }

  // Re-booting must not disturb what is already there: these are plain
  // CREATE TABLE IF NOT EXISTS, and a second boot that dropped a user would be
  // the worst possible way to find that out.
  db.close();
  const rebooted = tryBoot(path);
  check("it boots again with users already present", rebooted.ok, rebooted.ok ? "" : rebooted.err);
  const after = new DatabaseSync(path);
  // Two rows: the account created above, and the same address at the second
  // company (ADR 0018). Both must survive.
  const { n } = after.prepare("SELECT COUNT(*) AS n FROM users WHERE id IN ('u-1', 'u-elsewhere')").get() as { n: number };
  check("and the existing users survived the second boot", n === 2, `rows: ${n}`);
  after.close();
}

/**
 * Two PROCESSES redeeming one invite at the same instant.
 *
 * WHY THIS IS NOT IN verify-api, AND WHY IT EXISTS AT ALL. That suite fires two
 * concurrent HTTP signups and asserts one account results — and a break test
 * proved that assertion cannot fail, because `redeemInvite` contains no `await`
 * and Node therefore runs it to completion before the second request is
 * touched. In one process, JavaScript is the thing serialising them, not the
 * database. The transaction was untested.
 *
 * So the race is staged where it is real: two operating-system processes, one
 * database file, both told to strike at the same wall-clock moment. SQLite is
 * configured with `busy_timeout = 5000`, so the loser WAITS for the write lock
 * rather than failing to get it — which means what refuses the second
 * redemption is the guard inside the transaction, not a lock error.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the invariant: two
 * processes, one invite, one account, and the invite naming the winner.
 * It does NOT prove the transaction is what achieves that. Break-testing
 * removed `BEGIN IMMEDIATE` entirely and this test still passed, because the
 * window where a second process could read the invite as unredeemed is the few
 * microseconds between one SELECT and one UPDATE, and two processes
 * synchronised to the millisecond miss it almost every time. A test that only
 * fails occasionally is worse than one that says what it cannot see, so this
 * comment is the honest statement of its reach. The transaction stays because
 * the failure it prevents — two accounts from one invite — is the kind you
 * cannot undo, not because a test caught it.
 */
/**
 * TWO PROCESSES, ONE FOUNDING INVITE (ADR 0018).
 *
 * Since addresses became unique per company, single-use is the ONLY thing
 * stopping one founding invite from making company after company: each
 * redemption makes a new company, where the address has no account yet. A
 * sequential test of that cannot fail, because redeemInvite has no await, so
 * this is proven the way the joining invite is, by two operating-system
 * processes striking at one timestamp.
 */
async function verifyFoundingInviteRaceAcrossProcesses(dir: string): Promise<void> {
  console.log("\n== two processes, one founding invite ==");

  const path = join(dir, "founding-race.db");
  copyFileSync(join(dir, "scratch.db"), path);
  const booted = tryBoot(path);
  check("the founding-race database boots", booted.ok, booted.ok ? "" : booted.err);

  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const companiesBefore = count("companies");
  const usersBefore = count("users");

  const token = "a-founding-token-both-processes-will-try";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO invites (id, token_hash, company_id, email, role, created_at, expires_at,
                          redeemed_at, redeemed_by, revoked_at)
     VALUES ('founding-race', ?, NULL, 'founder-racer@example.com', 'owner', ?, ?, NULL, NULL, NULL)`,
  ).run(tokenHash, now, new Date(Date.now() + 3_600_000).toISOString());
  db.close();

  const startAt = Date.now() + 4000;
  const child = `
    import { redeemInvite } from ${JSON.stringify(join(process.cwd(), "src/db/invites.ts"))};
    const startAt = ${startAt};
    while (Date.now() < startAt) {}
    try {
      const user = redeemInvite({
        token: ${JSON.stringify(token)},
        email: "founder-racer@example.com",
        passwordHash: "v1.32768.8.1.c2FsdA.aGFzaA",
        companyName: "Racing Founders",
      });
      console.log("WON " + user.id);
    } catch (error) {
      console.log("LOST " + (error as Error).name);
      process.exit(3);
    }
  `;
  const run = () =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const proc = spawn("npx", ["tsx", "--input-type=module", "-e", child], {
        env: { ...process.env, FUEL_DB_PATH: path },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (out += d));
      proc.on("close", (code) => resolve({ code: code ?? -1, out }));
    });

  const results = await Promise.all([run(), run()]);
  const winners = results.filter((r) => r.out.includes("WON"));
  const losers = results.filter((r) => r.out.includes("LOST"));
  check(
    "exactly one process redeems the founding invite",
    winners.length === 1,
    results.map((r) => `exit ${r.code}: ${r.out.trim().split("\n").pop()}`).join(" | "),
  );
  check("and the other is refused", losers.length === 1);

  const after = new DatabaseSync(path);
  const companiesMade = (after.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number }).n - companiesBefore;
  const usersMade = (after.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n - usersBefore;
  check("exactly ONE company was created", companiesMade === 1, `created: ${companiesMade}`);
  check("and exactly one account", usersMade === 1, `created: ${usersMade}`);
  after.close();
}

async function verifyInviteRaceAcrossProcesses(dir: string): Promise<void> {
  console.log("\n== two processes, one invite ==");

  const path = join(dir, "race.db");
  copyFileSync(join(dir, "scratch.db"), path);
  const booted = tryBoot(path);
  check("the race database boots", booted.ok, booted.ok ? "" : booted.err);

  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  const company = db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string };
  const before = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

  const token = "a-token-both-processes-will-try";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO invites (id, token_hash, company_id, email, role, created_at, expires_at,
                          redeemed_at, redeemed_by, revoked_at)
     VALUES ('race-invite', ?, ?, 'racer@example.com', 'operator', ?, ?, NULL, NULL, NULL)`,
  ).run(tokenHash, company.id, now, new Date(Date.now() + 3_600_000).toISOString());
  db.close();

  // Both children sleep until the same timestamp, so the collision is real
  // rather than a hopeful consequence of process start-up timing.
  const startAt = Date.now() + 4000;
  const child = `
    import { redeemInvite } from ${JSON.stringify(join(process.cwd(), "src/db/invites.ts"))};
    const startAt = ${startAt};
    while (Date.now() < startAt) {}
    try {
      const user = redeemInvite({
        token: ${JSON.stringify(token)},
        email: "racer@example.com",
        passwordHash: "v1.32768.8.1.c2FsdA.aGFzaA",
      });
      console.log("WON " + user.id);
    } catch (error) {
      console.log("LOST " + (error as Error).name);
      process.exit(3);
    }
  `;

  const run = () =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const proc = spawn("npx", ["tsx", "--input-type=module", "-e", child], {
        env: { ...process.env, FUEL_DB_PATH: path },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (out += d));
      proc.on("close", (code) => resolve({ code: code ?? -1, out }));
    });

  const results = await Promise.all([run(), run()]);

  const winners = results.filter((r) => r.out.includes("WON"));
  const losers = results.filter((r) => r.out.includes("LOST"));
  check(
    "exactly one process redeems the invite",
    winners.length === 1,
    results.map((r) => `exit ${r.code}: ${r.out.trim().split("\n").pop()}`).join(" | "),
  );
  check("and the other is refused", losers.length === 1);

  const after = new DatabaseSync(path);
  const created = (after.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n - before;
  check("exactly one account was created", created === 1, `created: ${created}`);
  const invite = after.prepare("SELECT redeemed_by FROM invites WHERE id = 'race-invite'").get() as {
    redeemed_by: string | null;
  };
  check("and the invite names the account that won", invite.redeemed_by !== null);
  after.close();
}

/**
 * TWO OPERATORS, ONE HELD PAYMENT, THE SAME INSTANT.
 *
 * Commit C gave the dashboard the ability to decide, which means two people can
 * now be looking at the same queue and press different buttons at the same
 * moment. The interesting collision is not approve-versus-approve; it is
 * APPROVE VERSUS DENY, because the two outcomes disagree about whether money
 * moves. The failure to rule out is an operator being told "approved" by a 200
 * while the row they were looking at ends up denied — they would believe a
 * payment was released that was in fact refused, and no error would appear
 * anywhere.
 *
 * SINCE COMMIT D IT ALSO RACES THE AUDIT TRAIL. `decided_by` is written in the
 * same UPDATE as the status, so the row cannot end up saying one person decided
 * it while carrying another person's name. That is the failure this test exists
 * to rule out, and it is a nastier one than a double decision: a double
 * decision is visible, whereas an approval credited to somebody who did not
 * make it looks perfectly normal and is wrong exactly when it matters.
 *
 * WHY CROSS-PROCESS AND NOT TWO PROMISES. Established in Commit B and it still
 * holds: node:sqlite is synchronous and `decideRequest` contains
 * no `await`, so two calls in one process are serialised by JavaScript before
 * SQLite is ever asked to arbitrate. An in-process race test of this code
 * CANNOT FAIL, which makes it worse than no test. Two processes, busy-waiting
 * to one shared timestamp, is the only arrangement where the guard is what
 * decides the outcome.
 *
 * What the guard is: `WHERE id = ? AND status = 'pending'` plus a check that
 * exactly one row changed. A single UPDATE is atomic in SQLite, so the whole
 * decision is made inside one statement — there is no check-then-write window
 * to lose, which is why this needs no explicit transaction the way invite
 * redemption did.
 */
/**
 * Two processes posting the books at the same instant.
 *
 * WHY THIS IS CROSS-PROCESS AND NOTHING ELSE. `runPosting` has no `await`, so
 * two calls in one process are serialised by JavaScript before SQLite ever sees
 * them — an in-process version of this test cannot fail, and would pass just as
 * well with the transaction deleted. Only separate processes, each with its own
 * connection, contend for the write lock for real.
 *
 * WHAT IT PROTECTS. The run reads what each bucket owes AFTER `BEGIN IMMEDIATE`,
 * and `PRAGMA busy_timeout` makes a second writer WAIT for the lock rather than
 * fail. Read before the lock, both processes would see the same residual and the
 * one that waited would post it a second time once the first committed — money
 * booked twice, into books that are not edited afterwards. Read under the lock,
 * the second recomputes, finds sub-cent residuals, and posts nothing.
 *
 * TWO NEW COMPANIES, built here, so the outcome depends only on this fixture
 * and not on whatever else the scratch database holds.
 */
async function verifyPostingRaceAcrossProcesses(dir: string): Promise<void> {
  console.log("\n== two processes, one company's books ==");

  const path = join(dir, "posting-race.db");
  copyFileSync(join(dir, "scratch.db"), path);
  const booted = tryBoot(path);
  check("the race database boots", booted.ok, booted.ok ? "" : booted.err);

  const companies = [randomUUID(), randomUUID()] as const;
  const at = "2099-07-01T00:00:00.000Z";
  const seed = (db: DatabaseSync, companyId: string, host: string) => {
    const agent = db
      .prepare("SELECT a.id FROM agents a JOIN teams t ON t.id = a.team_id WHERE t.company_id = ?")
      .get(companyId) as { id: string } | undefined;
    // Three whole-cent payments, so there is a line's worth of POSTABLE money:
    // a race over sub-cent residuals would post nothing either way and prove
    // nothing.
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO payments (id, agent_id, amount_base_units, resource_url, status,
                               detail, created_at, settled_at)
         VALUES (?, ?, 20000, ?, 'settled', NULL, ?, ?)`,
      ).run(randomUUID(), agent!.id, `https://${host}/x`, at, at);
    }
  };

  {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON");
    companies.forEach((companyId, i) => {
      const team = randomUUID();
      db.prepare(
        `INSERT INTO companies (id, name, spend_cap_base_units, created_at)
         VALUES (?, ?, 1000000, ?)`,
      ).run(companyId, `Race Co ${i}`, at);
      db.prepare(
        `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
         VALUES (?, ?, 'Race Team', 1000000, ?)`,
      ).run(team, companyId, at);
      db.prepare(
        `INSERT INTO agents (id, name, team_id, fireblocks_vault_id, address,
                             spend_cap_base_units, created_at)
         VALUES (?, ?, ?, ?, '0xrace', 1000000, ?)`,
      ).run(randomUUID(), `race-agent-${i}`, team, `vault-posting-race-${companyId}`, at);
    });
    seed(db, companies[0], "race-same.test");
    db.close();
  }

  const spawnChild = (code: string) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const proc = spawn("npx", ["tsx", "--input-type=module", "-e", code], {
        env: { ...process.env, FUEL_DB_PATH: path },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (out += d));
      proc.on("close", (exit) => resolve({ code: exit ?? -1, out }));
    });

  const postingsModule = JSON.stringify(join(process.cwd(), "src/db/postings.ts"));
  const racer = (companyId: string, startAt: number) => `
    import { runPosting } from ${postingsModule};
    const startAt = ${startAt};
    while (Date.now() < startAt) {}
    const r = runPosting(${JSON.stringify(companyId)});
    console.log("RAN " + JSON.stringify({ runId: r.runId, lines: r.linesCreated }));
  `;
  const parse = (out: string) => {
    const m = out.match(/RAN (\{.*\})/);
    return m ? (JSON.parse(m[1]!) as { runId: string; lines: number }) : null;
  };
  const integrityOf = async (companyId: string) => {
    const r = await spawnChild(`
      import { verifyPostingIntegrity } from ${postingsModule};
      console.log("PROBLEMS " + JSON.stringify(verifyPostingIntegrity(${JSON.stringify(companyId)})));
    `);
    const m = r.out.match(/PROBLEMS (\[.*\])/);
    return m ? (JSON.parse(m[1]!) as { check: string; detail: string }[]) : [{ check: "unreadable", detail: r.out }];
  };

  /* --- the same company, twice, at one instant ------------------------------ */
  {
    const startAt = Date.now() + 4000;
    const results = await Promise.all([
      spawnChild(racer(companies[0], startAt)),
      spawnChild(racer(companies[0], startAt)),
    ]);
    const runs = results.map((r) => parse(r.out));
    const detail = results.map((r) => r.out.trim().split("\n").pop()).join(" | ");
    check("both runs complete", runs.every((r) => r !== null), detail);

    const posting = runs.filter((r) => r !== null && r.lines > 0);
    check(
      "exactly one of two simultaneous runs posts the money",
      posting.length === 1,
      detail,
    );
    check(
      "and the other, reading under the lock, finds nothing left to post",
      runs.filter((r) => r !== null && r.lines === 0).length === 1,
      detail,
    );

    /*
     * THE BOOKS, NOT JUST THE REPORTS. Two runs could each claim the right
     * number and still have double-absorbed a source; the integrity checker is
     * what reads the ledger itself. Conservation (owed = posted + carried) and
     * "no source absorbed for more than it is worth" are the two checks a
     * double post would trip.
     */
    const problems = await integrityOf(companies[0]);
    check(
      "the company's books are clean: conservation holds and nothing is absorbed twice",
      problems.length === 0,
      JSON.stringify(problems),
    );
  }

  /* --- two companies, at one instant ---------------------------------------- */
  console.log("\n== two processes, two companies' books ==");
  {
    {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys = ON");
      seed(db, companies[0], "race-apart-0.test");
      seed(db, companies[1], "race-apart-1.test");
      db.close();
    }

    const startAt = Date.now() + 4000;
    const results = await Promise.all([
      spawnChild(racer(companies[0], startAt)),
      spawnChild(racer(companies[1], startAt)),
    ]);
    const runs = results.map((r) => parse(r.out));
    const detail = results.map((r) => r.out.trim().split("\n").pop()).join(" | ");
    check(
      "two companies' runs at the same instant both post their own money",
      runs.every((r) => r !== null && r.lines > 0),
      detail,
    );

    /*
     * The lock is whole-database, so these two serialised rather than ran in
     * parallel — that is fine and expected. What must hold is that waiting
     * never became TRESPASSING: each run's lines belong to its own company.
     */
    const db = new DatabaseSync(path);
    runs.forEach((run, i) => {
      if (run === null) return;
      const foreign = db
        .prepare(
          `SELECT COUNT(*) AS n FROM posting_lines pl
             JOIN agents a ON a.id = pl.agent_id
             JOIN teams  t ON t.id = a.team_id
            WHERE pl.run_id = ? AND t.company_id != ?`,
        )
        .get(run.runId, companies[i]) as { n: number };
      check(`company ${i}'s run wrote none of the other company's lines`, Number(foreign.n) === 0);
    });
    db.close();

    for (const [i, companyId] of companies.entries()) {
      const problems = await integrityOf(companyId);
      check(
        `company ${i}'s books are clean afterwards`,
        problems.length === 0,
        JSON.stringify(problems),
      );
    }
  }
}

async function verifyDecisionRaceAcrossProcesses(dir: string): Promise<void> {
  console.log("\n== two processes, one held payment ==");

  const path = join(dir, "decision-race.db");
  copyFileSync(join(dir, "scratch.db"), path);
  const booted = tryBoot(path);
  check("the race database boots", booted.ok, booted.ok ? "" : booted.err);

  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  const agent = db.prepare(
    `SELECT a.id AS id, t.company_id AS company_id
       FROM agents a JOIN teams t ON t.id = a.team_id LIMIT 1`,
  ).get() as { id: string; company_id: string };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO approval_requests
       (id, agent_id, amount_base_units, resource_url, blocked_scope, status, created_at, detail)
     VALUES ('race-approval', ?, 5000, 'https://api.example.com/contested', 'company',
             'pending', ?, NULL)`,
  ).run(agent.id, now);

  /*
   * TWO DIFFERENT PEOPLE, so the row's `decided_by` can distinguish the winner
   * from the loser. With one user id on both sides the identity half of this
   * test would pass no matter which UPDATE landed last.
   */
  const insertUser = db.prepare(
    `INSERT INTO users (id, company_id, email, password_hash, role, created_at, disabled_at)
     VALUES (?, ?, ?, 'v1.32768.8.1.c2FsdA.aGFzaA', 'operator', ?, NULL)`,
  );
  insertUser.run("racer-approve", agent.company_id, "approver@example.com", now);
  insertUser.run("racer-deny", agent.company_id, "denier@example.com", now);
  db.close();

  const startAt = Date.now() + 4000;
  const child = (decision: "approve" | "deny") => `
    import { decideRequest } from ${JSON.stringify(join(process.cwd(), "src/db/approvals.ts"))};
    const startAt = ${startAt};
    while (Date.now() < startAt) {}
    const decided = decideRequest({
      id: "race-approval",
      companyId: ${JSON.stringify(agent.company_id)},
      decision: ${JSON.stringify(decision)},
      decidedBy: ${JSON.stringify("racer-" + decision)},
    });
    if (decided) console.log("WON ${decision} " + decided.status);
    else console.log("LOST ${decision}");
  `;

  const run = (decision: "approve" | "deny") =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const proc = spawn("npx", ["tsx", "--input-type=module", "-e", child(decision)], {
        env: { ...process.env, FUEL_DB_PATH: path },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (out += d));
      proc.on("close", (code) => resolve({ code: code ?? -1, out }));
    });

  const results = await Promise.all([run("approve"), run("deny")]);
  const detail = results.map((r) => r.out.trim().split("\n").pop()).join(" | ");

  const winners = results.filter((r) => r.out.includes("WON"));
  check("exactly one decision is recorded", winners.length === 1, detail);
  check("and the other is refused", results.filter((r) => r.out.includes("LOST")).length === 1, detail);

  /*
   * THE HALF THAT MATTERS. A winner is not enough: the status the winner was
   * TOLD it wrote has to be the status actually stored. If both UPDATEs landed,
   * one operator would hold a 200 saying "approved" over a row reading
   * "denied".
   */
  const after = new DatabaseSync(path);
  const row = after.prepare(
    `SELECT status, decided_at, decided_by, approval_expires_at
       FROM approval_requests WHERE id = 'race-approval'`,
  ).get() as {
    status: string;
    decided_at: string | null;
    decided_by: string | null;
    approval_expires_at: string | null;
  };
  const claimed = winners[0]?.out.match(/WON \w+ (\w+)/)?.[1];
  check(
    "and the winner was told exactly what the row now says",
    claimed === row.status,
    `winner claimed ${claimed}, row says ${row.status}`,
  );
  check(
    "the row is no longer pending",
    row.status === "approved" || row.status === "denied",
    `status: ${row.status}`,
  );
  check("and it carries exactly one decision timestamp", row.decided_at !== null);

  /*
   * THE AUDIT TRAIL NAMES THE WINNER, AND ONLY THE WINNER.
   *
   * `racer-approve` and `racer-deny` are two different people, so this can tell
   * them apart: whoever's decision is stored in `status` must be whoever is
   * stored in `decided_by`. Splitting the identity into its own UPDATE makes
   * the loser able to overwrite the winner's name — an approval that reads
   * perfectly normal while crediting somebody who did not make the decision.
   */
  check(
    "and the name on it is the person whose decision was recorded",
    row.decided_by === (row.status === "approved" ? "racer-approve" : "racer-deny"),
    `status ${row.status}, decided_by ${row.decided_by}`,
  );
  check(
    "and it is not left nameless",
    row.decided_by !== null,
    "a decision made by a signed-in person must never store NULL, which is reserved for shared keys",
  );
  /*
   * An approval carries an expiry and a denial does not. Checked because it is
   * the field that would survive from a losing approve UPDATE if both ran: a
   * row reading "denied" while holding a live expiry is a permission that
   * outlives the refusal that was supposed to end it.
   */
  check(
    "a denied row holds no approval expiry",
    row.status !== "denied" || row.approval_expires_at === null,
    `status ${row.status}, expiry ${row.approval_expires_at}`,
  );
  after.close();
}

/**
 * 7A-3: the realm columns arrive on a database in today's shape, and are
 * filled in exactly once.
 *
 * Today's shape is the live database's: every rebuild already done, so the
 * three columns arrive by ALTER TABLE and the backfill is the only thing that
 * can attribute what already exists. Two companies, one connected and one
 * not, because the unconnected one is the case a careless backfill gets wrong
 * -- and it gets it wrong on the SECOND boot, not the first.
 */
function verifyRealmBackfill(dir: string): void {
  console.log("\n== 7A-3: which books each QuickBooks artifact belongs to, filled in once ==");
  const dbPath = join(dir, "realm-backfill.db");
  boot(dbPath);

  const TABLES: [string, string][] = [
    ["qbo_postings", "realm_id"],
    ["qbo_posting_drafts", "realm_id"],
    ["qbo_config", "accounts_realm_id"],
  ];
  const columnsOf = (db: DatabaseSync, table: string) =>
    (db.prepare(`PRAGMA table_info('${table}')`).all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );

  let db = new DatabaseSync(dbPath);
  const fresh = Object.fromEntries(TABLES.map(([t]) => [t, columnsOf(db, t)]));
  for (const [table, column] of TABLES) {
    check(`a fresh ${table} has ${column}`, fresh[table]!.includes(column));
    // Directly after the columns the table was first declared with, which is
    // where ALTER TABLE puts it on an old database. (It was last until item 3
    // appended qbo_postings' write-off columns after it, in the same order a
    // migration does -- which the order check further down pins.)
    const declaredLast = { qbo_postings: "posted_at", qbo_posting_drafts: "created_at", qbo_config: "updated_at" }[
      table
    ]!;
    check(
      `and it comes straight after ${table}'s original columns, where ALTER TABLE would also put it`,
      fresh[table]!.indexOf(column) === fresh[table]!.indexOf(declaredLast) + 1,
      fresh[table]!.join(","),
    );
  }

  const now = new Date().toISOString();
  const connected = (db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string }).id;
  const unconnected = randomUUID();
  db.prepare(
    `INSERT INTO companies (id, name, spend_cap_base_units, created_at)
     VALUES (?, 'Never connected', 1000000, ?)`,
  ).run(unconnected, now);
  const insertConnection = (id: string, companyId: string, realm: string) =>
    db
      .prepare(
        `INSERT INTO qbo_connections (id, company_id, realm_id, access_token_enc, access_expires_at,
                                      refresh_token_enc, refresh_expires_at, connected_at, updated_at)
         VALUES (?, ?, ?, 'enc', ?, 'enc', ?, ?, ?)`,
      )
      .run(id, companyId, realm, now, now, now, now);
  insertConnection("conn-connected", connected, "books-then");

  for (const [who, companyId] of [["c", connected], ["u", unconnected]] as const) {
    db.prepare(
      `INSERT INTO qbo_posting_drafts (id, company_id, direction, grain, posting_day, counterparty,
                                       doc_number, payload_json, payload_hash, source_fingerprint,
                                       status, created_at)
       VALUES (?, ?, 'spend', 'daily', '2026-09-01', NULL, ?, '{}', 'h', 'f', 'posted', ?)`,
    ).run(`draft-${who}`, companyId, `FUEL-${who}`, now);
    db.prepare(
      `INSERT INTO qbo_postings (id, company_id, draft_id, doc_number, request_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'posted', ?)`,
    ).run(`posting-${who}`, companyId, `draft-${who}`, `FUEL-${who}`, `req-${who}`, now);
    db.prepare(
      `INSERT OR REPLACE INTO qbo_config (company_id, expense_account_id, updated_at) VALUES (?, '63', ?)`,
    ).run(companyId, now);
  }

  // Back to the shape the live database is in before 7A-3.
  for (const [table, column] of TABLES) {
    if (table === "qbo_postings") rebuildPostingsAs(db, "pre-7A-3");
    else db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
  const rowCounts = () =>
    TABLES.map(([t]) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n));
  const countsBefore = rowCounts();
  db.close();

  const firstLog = boot(dbPath);
  for (const [table, column] of TABLES) {
    check(
      `the boot added ${table}.${column} and said what it attributed`,
      new RegExp(`added ${table}\\.${column}: 1 row\\(s\\) attributed .* 1 left unattributed`).test(firstLog),
      firstLog,
    );
  }

  db = new DatabaseSync(dbPath);
  const realmOf = (table: string, column: string, key: string, id: string) =>
    (db.prepare(`SELECT ${column} AS r FROM ${table} WHERE ${key} = ?`).get(id) as { r: string | null }).r;
  const snapshot = () => ({
    postingC: realmOf("qbo_postings", "realm_id", "id", "posting-c"),
    draftC: realmOf("qbo_posting_drafts", "realm_id", "id", "draft-c"),
    configC: realmOf("qbo_config", "accounts_realm_id", "company_id", connected),
    postingU: realmOf("qbo_postings", "realm_id", "id", "posting-u"),
    draftU: realmOf("qbo_posting_drafts", "realm_id", "id", "draft-u"),
    configU: realmOf("qbo_config", "accounts_realm_id", "company_id", unconnected),
  });
  const first = snapshot();
  check("a connected company's posting is attributed to its books", first.postingC === "books-then", String(first.postingC));
  check("so is its draft", first.draftC === "books-then", String(first.draftC));
  check("and its account mapping", first.configC === "books-then", String(first.configC));
  check(
    "an UNCONNECTED company's posting is left unattributed, not guessed",
    first.postingU === null,
    String(first.postingU),
  );
  check("and its draft", first.draftU === null, String(first.draftU));
  check("and its account mapping", first.configU === null, String(first.configU));
  check("no row was added or lost", JSON.stringify(rowCounts()) === JSON.stringify(countsBefore));
  for (const [table] of TABLES) {
    check(`${table}'s columns are in the same order as a fresh database's`, columnsOf(db, table).join(",") === fresh[table]!.join(","));
  }

  /*
   * THE SECOND BOOT, AND THE REASON IT IS HERE. The unconnected company now
   * connects -- to different books. Its old artifacts were never made there.
   * A backfill that swept "any row still NULL" on every boot would now stamp
   * them with books-now: a false record written by the migration itself.
   */
  insertConnection("conn-later", unconnected, "books-now");
  db.close();
  const secondLog = boot(dbPath);
  check("the second boot adds no column", !/added qbo_(postings|posting_drafts|config)\./.test(secondLog), secondLog);

  db = new DatabaseSync(dbPath);
  const second = snapshot();
  check(
    "the later connection did NOT attribute the old artifacts to its books",
    second.postingU === null && second.draftU === null && second.configU === null,
    JSON.stringify(second),
  );
  check(
    "and the attributed ones are untouched",
    second.postingC === "books-then" && second.draftC === "books-then" && second.configC === "books-then",
  );
  const fk = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  check("no foreign key violations", fk.length === 0, String(fk.length));
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  check("integrity_check is ok", integrity.integrity_check === "ok", integrity.integrity_check);
  db.close();
}

/**
 * 7A-3 item 3: the write-off columns arrive on a database in the live shape
 * (realm recorded, no write-off columns) and fill in NOTHING.
 *
 * No backfill is the claim under test. Nothing was ever written off before this
 * existed, so every existing posting -- pending ones above all -- must come out
 * with all four NULL. A migration that "helpfully" marked anything written off
 * would lift the guard on changing books for a posting nobody decided about.
 */
function verifyWriteOffColumns(dir: string): void {
  console.log("\n== 7A-3 item 3: the write-off columns arrive empty ==");
  const WRITE_OFF = ["abandoned_at", "abandoned_by", "abandon_reason", "abandon_evidence"];
  const dbPath = join(dir, "write-off.db");
  boot(dbPath);

  const columnsOf = (db: DatabaseSync) =>
    (db.prepare("PRAGMA table_info('qbo_postings')").all() as unknown as { name: string }[]).map((c) => c.name);
  let db = new DatabaseSync(dbPath);
  const fresh = columnsOf(db);
  check(
    "a fresh qbo_postings ends with the four write-off columns, in order",
    JSON.stringify(fresh.slice(-4)) === JSON.stringify(WRITE_OFF),
    fresh.join(","),
  );

  const now = new Date().toISOString();
  const companyId = (db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string }).id;
  for (const [id, status] of [["wo-pending", "pending"], ["wo-posted", "posted"]] as const) {
    db.prepare(
      `INSERT INTO qbo_posting_drafts (id, company_id, direction, grain, posting_day, counterparty,
                                       doc_number, payload_json, payload_hash, source_fingerprint,
                                       status, created_at, realm_id)
       VALUES (?, ?, 'spend', 'daily', '2026-09-01', NULL, ?, '{}', 'h', 'f', 'posted', ?, 'books')`,
    ).run(`draft-${id}`, companyId, `FUEL-${id}`, now);
    db.prepare(
      `INSERT INTO qbo_postings (id, company_id, draft_id, doc_number, request_id, status, created_at, realm_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'books')`,
    ).run(id, companyId, `draft-${id}`, `FUEL-${id}`, `req-${id}`, status, now);
  }
  rebuildPostingsAs(db, "item-2");
  check("the rebuilt table is in the live shape: realm, no write-off columns", !columnsOf(db).includes("abandoned_at") && columnsOf(db).includes("realm_id"));
  db.close();

  const firstLog = boot(dbPath);
  for (const column of WRITE_OFF) {
    check(`the boot added qbo_postings.${column}`, firstLog.includes(`added qbo_postings.${column}`), firstLog);
  }
  db = new DatabaseSync(dbPath);
  check(
    "and the migrated table has the same columns, in the same order, as a fresh one",
    columnsOf(db).join(",") === fresh.join(","),
    columnsOf(db).join(","),
  );
  const rows = db
    .prepare(
      "SELECT id, status, realm_id, abandoned_at, abandoned_by, abandon_reason, abandon_evidence FROM qbo_postings ORDER BY id",
    )
    .all() as unknown as Record<string, string | null>[];
  check("no row was lost", rows.length === 2);
  check(
    "NOTHING WAS WRITTEN OFF BY THE MIGRATION -- all four columns NULL on every row, the pending one included",
    rows.every((r) => WRITE_OFF.every((c) => r[c] === null)),
    JSON.stringify(rows),
  );
  check("and the realm survived the rebuild", rows.every((r) => r.realm_id === "books"));
  check(
    "the live-number index is back after the boot",
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'qbo_postings_live_doc_uniq'").get() as
      | { name: string }
      | undefined) !== undefined,
  );
  db.close();

  const secondLog = boot(dbPath);
  check("a second boot adds nothing", !/added qbo_postings\.abandon/.test(secondLog), secondLog);
  db = new DatabaseSync(dbPath);
  const fk = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  check("no foreign key violations", fk.length === 0, String(fk.length));
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  check("integrity_check is ok", integrity.integrity_check === "ok", integrity.integrity_check);
  db.close();
}

function verifyOAuthStateStarter(dir: string): void {
  console.log("\n== 7A-3 item 4: a connect link records who started it, and old links name nobody ==");
  const dbPath = join(dir, "oauth-starter.db");
  boot(dbPath);

  const columnsOf = (db: DatabaseSync) =>
    (db.prepare("PRAGMA table_info('qbo_oauth_states')").all() as unknown as { name: string }[]).map((c) => c.name);
  let db = new DatabaseSync(dbPath);
  const fresh = columnsOf(db);
  check("a fresh qbo_oauth_states has created_by", fresh.includes("created_by"), fresh.join(","));
  const fkTargets = (db.prepare("PRAGMA foreign_key_list('qbo_oauth_states')").all() as unknown as {
    from: string;
    table: string;
  }[]).map((f) => `${f.from}->${f.table}`);
  check("and it is a foreign key into users", fkTargets.includes("created_by->users"), fkTargets.join(","));

  /*
   * BACK TO THE SHAPE BEFORE THIS ITEM, by a rebuild: SQLite will not DROP a
   * column that is a foreign key. Nothing references this table, so a plain
   * copy-and-rename is the whole of it. Two states are left in it, one live
   * and one spent, the way a database upgraded mid-connection would hold them.
   */
  const companyId = (db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string }).id;
  db.exec(`
    BEGIN;
    CREATE TABLE qbo_oauth_states_old (
      state        TEXT PRIMARY KEY,
      company_id   TEXT NOT NULL REFERENCES companies(id),
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      consumed_at  TEXT
    );
    DROP TABLE qbo_oauth_states;
    ALTER TABLE qbo_oauth_states_old RENAME TO qbo_oauth_states;
    CREATE INDEX qbo_oauth_states_expiry_idx ON qbo_oauth_states(expires_at);
    COMMIT;
  `);
  const later = new Date(Date.now() + 600_000).toISOString();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO qbo_oauth_states (state, company_id, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?)",
  ).run("old-live", companyId, now, later, null);
  db.prepare(
    "INSERT INTO qbo_oauth_states (state, company_id, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?)",
  ).run("old-spent", companyId, now, later, now);
  // The company has a person in it, as any real one does. Without one, a
  // migration that "helpfully" named each old state's company owner would find
  // nobody to name and this test could not tell it apart from doing nothing.
  db.prepare(
    `INSERT INTO users (id, company_id, email, password_hash, role, created_at)
     VALUES ('starter-owner', ?, 'owner@oauth-starter.test', 'not-a-hash', 'owner', ?)`,
  ).run(companyId, now);
  check("the rebuilt table is in the old shape", !columnsOf(db).includes("created_by"));
  db.close();

  const firstLog = boot(dbPath);
  check("the boot added qbo_oauth_states.created_by", firstLog.includes("added qbo_oauth_states.created_by"), firstLog);
  db = new DatabaseSync(dbPath);
  check(
    "and the migrated table has the same columns, in the same order, as a fresh one",
    columnsOf(db).join(",") === fresh.join(","),
    columnsOf(db).join(","),
  );
  const rows = db
    .prepare("SELECT state, consumed_at, created_by FROM qbo_oauth_states ORDER BY state")
    .all() as unknown as Record<string, string | null>[];
  check("no state was lost", rows.length === 2, JSON.stringify(rows));
  check(
    "NOBODY WAS NAMED BY THE MIGRATION -- created_by is NULL on both old states, so the callback refuses them",
    rows.every((r) => r.created_by === null),
    JSON.stringify(rows),
  );
  check("and the spent one is still spent", rows.find((r) => r.state === "old-spent")?.consumed_at === now);
  db.close();

  const secondLog = boot(dbPath);
  check("a second boot adds nothing", !/added qbo_oauth_states/.test(secondLog), secondLog);
  db = new DatabaseSync(dbPath);
  const fk = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  check("no foreign key violations", fk.length === 0, String(fk.length));
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  check("integrity_check is ok", integrity.integrity_check === "ok", integrity.integrity_check);
  db.close();
}

/**
 * ADR 0018: an address is unique within a company, and a company has a
 * sign-in handle. A database from before both is rebuilt once, keeping every
 * account and everything that points at one.
 */
function verifyCompanyScopedAccounts(dir: string): void {
  console.log("\n== ADR 0018: accounts belong to a company, and companies have handles ==");
  const dbPath = join(dir, "company-scoped.db");
  boot(dbPath);

  const uniqueSets = (db: DatabaseSync) =>
    (db.prepare("PRAGMA index_list(users)").all() as unknown as { name: string; unique: number }[])
      .filter((i) => i.unique === 1)
      .map((i) =>
        (db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all() as unknown as { seqno: number; name: string }[])
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => c.name)
          .join(","),
      );
  const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  let db = new DatabaseSync(dbPath);
  check("a fresh database is born per-company: users unique on (company_id, email)", uniqueSets(db).includes("company_id,email"), uniqueSets(db).join(" | "));
  check("and not on email alone", !uniqueSets(db).includes("email"), uniqueSets(db).join(" | "));
  const freshHandles = db.prepare("SELECT handle FROM companies").all() as { handle: string | null }[];
  check("every company on a fresh database has a handle", freshHandles.every((c) => c.handle !== null && HANDLE.test(c.handle)), JSON.stringify(freshHandles));

  /*
   * BACK TO THE SHAPE BEFORE ADR 0018. Companies lose the handle column (a
   * plain column once its index is dropped, so DROP COLUMN works), and users
   * are rebuilt with the old global `email UNIQUE`. Foreign keys off for the
   * rebuild, exactly as the migration itself does it.
   */
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    BEGIN;
    CREATE TABLE companies_old (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL UNIQUE,
      spend_cap_base_units INTEGER NOT NULL,
      created_at           TEXT NOT NULL
    );
    INSERT INTO companies_old SELECT id, name, spend_cap_base_units, created_at FROM companies;
    DROP TABLE companies;
    ALTER TABLE companies_old RENAME TO companies;
    CREATE TABLE users_old (
      id            TEXT PRIMARY KEY,
      company_id    TEXT NOT NULL REFERENCES companies(id),
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('owner', 'operator')),
      created_at    TEXT NOT NULL,
      disabled_at   TEXT
    );
    INSERT INTO users_old SELECT id, company_id, email, password_hash, role, created_at, disabled_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_old RENAME TO users;
    CREATE INDEX users_company_idx ON users(company_id);
    COMMIT;
  `);
  db.exec("PRAGMA foreign_keys = ON");
  check("the downgraded users table is in the old shape (email unique on its own)", uniqueSets(db).includes("email"), uniqueSets(db).join(" | "));
  const companyUniques = () =>
    (db.prepare("PRAGMA index_list(companies)").all() as unknown as { name: string; unique: number }[])
      .filter((i) => i.unique === 1)
      .map((i) =>
        (db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all() as unknown as { name: string }[]).map((c) => c.name).join(","),
      );
  check("and companies are in the old shape: name unique, no handle", companyUniques().includes("name") &&
    !(db.prepare("PRAGMA table_info(companies)").all() as unknown as { name: string }[]).some((c) => c.name === "handle"));

  // Two companies whose names make the SAME slug, so a "-2" scheme would show.
  const now = new Date().toISOString();
  // Real spend caps, including one beyond 2^53, so a copy that went through a
  // JavaScript number would be caught rounding it.
  db.prepare("INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES ('co-1', 'Acme Inc', 5000000, ?)").run(now);
  db.prepare("INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES ('co-2', 'ACME, inc.', 9007199254740993, ?)").run(now);
  db.prepare("INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at) VALUES ('team-1', 'co-1', 'Team One', 100, ?)").run(now);
  const addUser = (id: string, companyId: string, email: string) =>
    db
      .prepare(
        `INSERT INTO users (id, company_id, email, password_hash, role, created_at, disabled_at)
         VALUES (?, ?, ?, 'v1.32768.8.1.c2FsdA.aGFzaA', 'owner', ?, NULL)`,
      )
      .run(id, companyId, email, now);
  addUser("user-1", "co-1", "one@example.com");
  addUser("user-2", "co-2", "two@example.com");
  // Rows that point at a user, from the tables that reference users.
  db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, revoked_at) VALUES ('sess-1', 'user-1', ?, ?, ?, NULL)",
  ).run(now, "2099-01-01T00:00:00.000Z", now);
  db.prepare(
    `INSERT INTO invites (id, token_hash, company_id, email, role, created_at, expires_at, redeemed_at, redeemed_by, revoked_at)
     VALUES ('inv-1', 'hash-1', 'co-1', 'one@example.com', 'owner', ?, '2099-01-01T00:00:00.000Z', ?, 'user-1', NULL)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO qbo_oauth_states (state, company_id, created_at, expires_at, consumed_at, created_by)
     VALUES ('state-1', 'co-2', ?, '2099-01-01T00:00:00.000Z', NULL, 'user-2')`,
  ).run(now);
  const usersBefore = db.prepare("SELECT id, company_id, email FROM users ORDER BY id").all();
  const companiesBefore = JSON.stringify(
    db.prepare("SELECT id, name, CAST(spend_cap_base_units AS TEXT) AS cap, created_at FROM companies ORDER BY id").all(),
  );
  db.close();

  const firstLog = boot(dbPath);
  check("the boot rebuilt users", firstLog.includes("an address is now unique per company"), firstLog);
  check("and rebuilt companies", firstLog.includes("a name is no longer unique"), firstLog);
  check("and gave the companies handles", /gave \d+ company\(ies\) a sign-in handle/.test(firstLog), firstLog);
  db = new DatabaseSync(dbPath);
  check("users are now unique on (company_id, email)", uniqueSets(db).includes("company_id,email"), uniqueSets(db).join(" | "));
  check("and no longer on email alone", !uniqueSets(db).includes("email"), uniqueSets(db).join(" | "));
  check("companies have no unique index on name any more", !companyUniques().includes("name"), companyUniques().join(" | "));
  check("but the handle is still unique", companyUniques().includes("handle"), companyUniques().join(" | "));
  check(
    "every company row is identical, spend caps included, to the last base unit",
    JSON.stringify(
      db.prepare("SELECT id, name, CAST(spend_cap_base_units AS TEXT) AS cap, created_at FROM companies ORDER BY id").all(),
    ) === companiesBefore,
  );
  check("a team still resolves to its company", !!db.prepare("SELECT 1 FROM teams t JOIN companies c ON c.id = t.company_id WHERE t.id = 'team-1'").get());
  db.prepare("INSERT INTO companies (id, name, spend_cap_base_units, created_at, handle) VALUES ('co-3', 'Acme Inc', 0, ?, 'acme-inc-zzzz')").run(now);
  check("two companies can share a name now", (db.prepare("SELECT COUNT(*) AS n FROM companies WHERE name = 'Acme Inc'").get() as { n: number }).n === 2);
  db.prepare("DELETE FROM companies WHERE id = 'co-3'").run();
  check(
    "every account survived, with the same id, company and address",
    JSON.stringify(db.prepare("SELECT id, company_id, email FROM users ORDER BY id").all()) === JSON.stringify(usersBefore),
  );
  const resolves = (sql: string) => !!db.prepare(sql).get();
  check("a session still resolves to its user", resolves("SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = 'sess-1' AND u.id = 'user-1'"));
  check("an invite still names who redeemed it", resolves("SELECT 1 FROM invites i JOIN users u ON u.id = i.redeemed_by WHERE i.id = 'inv-1'"));
  check("a connect link still names who started it", resolves("SELECT 1 FROM qbo_oauth_states o JOIN users u ON u.id = o.created_by WHERE o.state = 'state-1'"));
  for (const table of ["sessions", "invites", "approval_requests", "qbo_postings", "qbo_oauth_states"]) {
    const targets = (db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as unknown as { table: string }[]).map((f) => f.table);
    check(`${table} still references users`, targets.includes("users"), targets.join(","));
  }

  const handles = db.prepare("SELECT id, handle FROM companies WHERE id IN ('co-1', 'co-2') ORDER BY id").all() as {
    id: string;
    handle: string | null;
  }[];
  check("both companies got a handle", handles.length === 2 && handles.every((h) => h.handle !== null), JSON.stringify(handles));
  check(
    "each is the shared slug plus four random characters, so neither is \"-2\"",
    handles.every((h) => /^acme-inc-[a-hj-km-np-z2-9]{4}$/.test(h.handle ?? "")),
    JSON.stringify(handles),
  );
  check("and they differ", handles[0]!.handle !== handles[1]!.handle, JSON.stringify(handles));
  const fk = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  check("no foreign key violations", fk.length === 0, String(fk.length));
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  check("integrity_check is ok", integrity.integrity_check === "ok", integrity.integrity_check);
  const handlesAfterFirst = JSON.stringify(handles);
  db.close();

  const secondLog = boot(dbPath);
  check("a second boot rebuilds nothing", !secondLog.includes("an address is now unique per company"), secondLog);
  check("and does not rebuild companies again", !secondLog.includes("a name is no longer unique"), secondLog);
  check("and re-names no company", !/gave \d+ company\(ies\)/.test(secondLog), secondLog);
  db = new DatabaseSync(dbPath);
  check(
    "the handles are exactly as the first boot left them",
    JSON.stringify(db.prepare("SELECT id, handle FROM companies WHERE id IN ('co-1', 'co-2') ORDER BY id").all()) === handlesAfterFirst,
  );
  db.close();
}

function verifyQuickBooksUniqueness(dir: string): void {
  const indexExists = (db: DatabaseSync, name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);

  console.log("\n== quickbooks: two live attempts on one number are refused by name ==");
  {
    const path = join(dir, "qbo-live-doc.db");
    boot(path);
    let db = new DatabaseSync(path);
    check("a fresh boot creates the live-number index", indexExists(db, "qbo_postings_live_doc_uniq"));
    const company = (db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string }).id;
    db.exec("DROP INDEX qbo_postings_live_doc_uniq");
    const draft = (id: string) =>
      db
        .prepare(
          `INSERT INTO qbo_posting_drafts (id, company_id, direction, grain, posting_day, counterparty, doc_number,
             payload_json, payload_hash, source_fingerprint, status, created_at)
           VALUES (?, ?, 'spend', 'daily', '2026-09-01', NULL, 'FUEL-clash', '{}', 'h', 'f', 'posted', '2026-09-01T00:00:00.000Z')`,
        )
        .run(id, company);
    const attempt = (id: string, draftId: string, status: string) =>
      db
        .prepare(
          `INSERT INTO qbo_postings (id, company_id, draft_id, doc_number, request_id, status, created_at)
           VALUES (?, ?, ?, 'FUEL-clash', ?, ?, '2026-09-01T00:00:00.000Z')`,
        )
        .run(id, company, draftId, `req-${id}`, status);
    draft("d-1");
    draft("d-2");
    attempt("att-posted", "d-1", "posted");
    attempt("att-pending", "d-2", "pending");
    db.close();

    const refused = tryBoot(path);
    check(
      "a database holding two live attempts on one number does not boot, and names both",
      !refused.ok &&
        /more than one pending or posted QuickBooks attempt shares a document number/.test(refused.err) &&
        /FUEL-clash: (att-posted, att-pending|att-pending, att-posted)/.test(refused.err),
      refused.ok ? "booted" : refused.err.slice(0, 300),
    );
    db = new DatabaseSync(path);
    check("and neither attempt was touched", Number((db.prepare("SELECT COUNT(*) AS n FROM qbo_postings WHERE doc_number = 'FUEL-clash' AND status IN ('pending','posted')").get() as { n: number }).n) === 2);

    // The operator's resolution: the one that created nothing is marked failed.
    db.prepare("UPDATE qbo_postings SET status = 'failed' WHERE id = 'att-pending'").run();
    db.close();
    check("once resolved, it boots", tryBoot(path).ok);
    db = new DatabaseSync(path);
    check("and the index is in place", indexExists(db, "qbo_postings_live_doc_uniq"));
    draft("d-3");
    attempt("att-failed-again", "d-3", "failed");
    check("a second FAILED attempt on the number is accepted — the index is partial", true);
    throws(
      "but a second live attempt is refused by the database itself",
      () => attempt("att-live-again", "d-3", "pending"),
      /UNIQUE constraint failed: qbo_postings\.company_id, qbo_postings\.doc_number/,
    );
    db.close();
  }

  console.log("\n== quickbooks: one set of books, one Fuel company ==");
  {
    const path = join(dir, "qbo-realm.db");
    boot(path);
    let db = new DatabaseSync(path);
    check("a fresh boot creates the realm index", indexExists(db, "qbo_connections_realm_uniq"));
    const first = (db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: string }).id;
    db.prepare(
      "INSERT INTO companies (id, name, spend_cap_base_units, created_at) VALUES ('second-co', 'Second Co', 0, '2026-09-01T00:00:00.000Z')",
    ).run();
    db.exec("DROP INDEX qbo_connections_realm_uniq");
    const connect = (id: string, companyId: string, realm: string) =>
      db
        .prepare(
          `INSERT INTO qbo_connections (id, company_id, realm_id, access_token_enc, access_expires_at,
             refresh_token_enc, refresh_expires_at, connected_at, updated_at)
           VALUES (?, ?, ?, 'enc', 'x', 'enc', 'x', 'x', 'x')`,
        )
        .run(id, companyId, realm);
    connect("conn-1", first, "shared-realm");
    connect("conn-2", "second-co", "shared-realm");
    db.close();

    const refused = tryBoot(path);
    check(
      "two Fuel companies on one QuickBooks company do not boot, and the refusal names them",
      !refused.ok && /realm shared-realm: .*second-co/.test(refused.err),
      refused.ok ? "booted" : refused.err.slice(0, 300),
    );
    db = new DatabaseSync(path);
    check("and neither connection was removed", Number((db.prepare("SELECT COUNT(*) AS n FROM qbo_connections").get() as { n: number }).n) === 2);
    db.prepare("DELETE FROM qbo_connections WHERE id = 'conn-2'").run();
    db.close();
    check("once one is disconnected, it boots", tryBoot(path).ok);
    db = new DatabaseSync(path);
    throws(
      "and the database itself refuses a second company on that realm",
      () => connect("conn-3", "second-co", "shared-realm"),
      /UNIQUE constraint failed: qbo_connections\.realm_id/,
    );
    db.close();
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
