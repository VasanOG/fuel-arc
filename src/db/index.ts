/**
 * SQLite connection and schema.
 *
 * Why SQLite and not the Postgres named in docs/architecture.md:
 * docs/decisions/0004-sqlite-for-phase-1.md.
 *
 * Every query lives in src/db/*.ts so swapping the engine later stays
 * contained to this directory.
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { deriveLabel } from "../lib/endpoint-label.js";
import { newHandle } from "../lib/handles.js";

/**
 * EXPORTED so a script can say out loud which database it is about to write
 * to. Security review asked for it on the two Stage 3 scripts that write — a
 * reset password and a minted invite are both irreversible enough that "which
 * environment did I just touch?" should never be a question.
 */
export const DB_PATH = process.env.FUEL_DB_PATH ?? "fuel.db";

export const db = new DatabaseSync(DB_PATH);

// Without this SQLite does not enforce foreign keys — a payment could
// reference an agent that does not exist.
db.exec("PRAGMA foreign_keys = ON");

// Wait rather than throwing SQLITE_BUSY the instant another writer holds the
// lock. Contention here is the cap check serialising, which is working as
// intended; failing it would surface as a flaky 500.
db.exec("PRAGMA busy_timeout = 5000");

/**
 * Every status a payment can hold. Kept as one constant because it has to
 * appear identically in the CHECK constraint and in the migration below —
 * two copies that could drift is exactly how the `unreconciled` bug happened.
 */
const PAYMENT_STATUSES = ["pending", "signing", "settled", "blocked", "failed", "unreconciled"];
const STATUS_CHECK = PAYMENT_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * The ledger classes, for the CHECK on posting_lines and for its migration.
 *
 * Kept as one constant for the same reason PAYMENT_STATUSES is: the list has to
 * appear identically in the CREATE and in the migration that rebuilds it, and
 * two copies that could drift is exactly how the `unreconciled` bug happened.
 *
 * Not imported from accounting/rollup.ts deliberately — db/index.ts is the
 * bottom of the import graph and pulling a domain module into it to build a
 * DDL string would invert that. The two are held together by
 * scripts/verify-rollup.ts, which asserts they agree.
 */
const LEDGER_CLASSES_DDL = ["expense", "suspense", "revenue"];
const LEDGER_CLASS_CHECK = LEDGER_CLASSES_DDL.map((c) => `'${c}'`).join(", ");

/** Inbound statuses. Mirrors ReceiptStatus in db/receipts.ts; see the note there. */
const RECEIPT_STATUSES_DDL = [
  "awaiting",
  "served_unsettled",
  "settle_unknown",
  "settled",
  "abandoned",
];
const RECEIPT_STATUS_CHECK = RECEIPT_STATUSES_DDL.map((s) => `'${s}'`).join(", ");

const paymentsTable = (name: string) => `
  CREATE TABLE ${name} (
    id                TEXT PRIMARY KEY,
    agent_id          TEXT NOT NULL REFERENCES agents(id),
    amount_base_units INTEGER NOT NULL,
    resource_url      TEXT NOT NULL,
    -- pending: budget reserved, nothing signed yet. Counts against the cap so
    --   two concurrent payments cannot both pass the check (TOCTOU overspend).
    --   Safe to release if abandoned: no authorization exists.
    -- signing: we are about to produce (or have produced) an EIP-3009
    --   authorization. Written BEFORE the signing call so that a crash mid-
    --   flight is distinguishable from a crash before signing — without this,
    --   crash recovery cannot tell "no money can move" from "money may have
    --   already moved" and has to guess. Counts.
    -- settled: money moved. Counts.
    -- blocked: refused by a cap. Nothing was signed, so it does not count.
    -- failed: NO SPENDABLE AUTHORIZATION EXISTS, so the reservation is safe to
    --   release. Reached two ways, and the invariant rather than the timing is
    --   what the status means. Usually: failed before anything was signed.
    --   Also: an operator reconciled an unreconciled row after establishing
    --   the authorization died unused (past its validBefore, never consumed),
    --   which satisfies the same invariant at a later moment. The second path
    --   was added in 6B-2 -- before it, budget held by an unreconciled row
    --   could never be released by anything. NOTE: no backticks anywhere in
    --   this DDL -- it is a JS template literal, so one would end the string.
    -- unreconciled: failed AFTER signing. An EIP-3009 authorization is
    --   spendable by the facilitator until it expires, so we must assume the
    --   money moved and keep the budget consumed. Releasing these would let a
    --   resource server settle-then-error in a loop and spend without limit.
    --   Not terminal: see reconcileUnreconciledPayment in db/payments.ts. It is
    --   the only way out, it requires a human's finding, and it records that a
    --   human is what it was -- a payment row stores no authorization nonce, so
    --   unlike a receipt this cannot be settled by asking the chain.
    status            TEXT NOT NULL CHECK (status IN (${STATUS_CHECK})),
    tx_hash           TEXT,
    detail            TEXT,
    created_at        TEXT NOT NULL,
    -- When money actually moved, as distinct from created_at, which is when
    -- budget was RESERVED. The accounting export dates a transaction by this,
    -- because "we decided to pay" and "the payment happened" are different
    -- events and a ledger wants the second one.
    --
    -- NULL for anything not settled, and for rows that settled before this
    -- column existed — their true settlement time is unrecoverable, so the
    -- export falls back to created_at rather than inventing one.
    settled_at        TEXT,
    -- WHY Fuel refused, as a closed code rather than prose. Set only on
    -- 'blocked' rows and only by recordBlocked; NULL everywhere else,
    -- including on every row recorded before this column existed. Those keep
    -- NULL forever and report "reason unavailable": detail holds sentences
    -- that LOOK parseable ("would exceed team spend cap") and deliberately are
    -- not parsed, because free text was never a contract and deriving a code
    -- from one would be inventing a record rather than reading it.
    --
    -- No CHECK constraint, deliberately. Adding one to an existing table means
    -- SQLite's full rebuild dance, and payments is referenced by
    -- approval_requests.payment_id and export_postings.payment_id under
    -- PRAGMA foreign_keys = ON. Rebuilding the money table to constrain a
    -- nullable annotation is a bad trade. The compensating controls are a
    -- single write path, a closed TypeScript union (RefusalCode), and an
    -- assertion in scripts/verify-api.ts that every non-null value is known.
    refusal_code      TEXT,
    -- Synthetic rows created by scripts/seed-demo-day.ts, so a demo can be
    -- told from real spend without reading free text.
    --
    -- Structural, and that matters: the delete predicate in the seed script
    -- used to be a match on detail = "demo-seed", and payments.detail can carry a
    -- string a THIRD-PARTY MERCHANT chose — describeRejection in
    -- src/payments/pay.ts writes JSON.parse(header).error verbatim. A
    -- merchant answering {"error":"demo-seed"} could therefore have a real
    -- payment deleted by a demo re-seed. This column is not reachable by any
    -- production write path: reserveIfUnderCap and recordBlocked omit it, so
    -- it defaults to 0 and there is no parameter to pass.
    is_demo           INTEGER NOT NULL DEFAULT 0
  )
`;

/**
 * The budget hierarchy: Company → Team → Agent, each with its own cap.
 *
 * The three are INDEPENDENT ceilings, not an allocation. Nothing stops the
 * sum of a company's team caps exceeding the company's own cap, in the same
 * way a company card limit is not the sum of every employee's limit. What
 * each one bounds is money that actually moved beneath it. All three are
 * checked at spend time, in one transaction — see reserveIfUnderCap.
 */
function companiesTable(name: string): string {
  return `
  CREATE TABLE IF NOT EXISTS ${name} (
    id                   TEXT PRIMARY KEY,
    -- NOT unique, since ADR 0018. It was, and a founder choosing a name already
    -- in use got a raw database error: a cross-company oracle on names. Nothing
    -- looks a company up by name; the handle below identifies one.
    name                 TEXT NOT NULL,
    -- Integer base units (USDC has 6 decimals). Never a float: a spend cap
    -- that drifts by a rounding error is a money bug.
    spend_cap_base_units INTEGER NOT NULL,
    created_at           TEXT NOT NULL,
    -- How a person names this company at sign-in (src/lib/handles.ts). Unique
    -- by an index created further down; nullable only until boot fills it.
    handle               TEXT
  );
`;
}
db.exec(companiesTable("companies"));

db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id                   TEXT PRIMARY KEY,
    company_id           TEXT NOT NULL REFERENCES companies(id),
    name                 TEXT NOT NULL,
    spend_cap_base_units INTEGER NOT NULL,
    created_at           TEXT NOT NULL,
    -- Scoped per company, not global: two companies may each have a
    -- "Platform" team. Company names stay globally unique.
    UNIQUE (company_id, name)
  );
`);

const agentsTable = (name: string) => `
  CREATE TABLE ${name} (
    id                   TEXT PRIMARY KEY,
    -- Unique per TEAM, not globally (see the UNIQUE below): two companies may
    -- each have a "researcher". Safe only because a vault is no longer named
    -- after its agent -- see migrateAgentsUniquePerTeamAndVault.
    name                 TEXT NOT NULL,
    team_id              TEXT NOT NULL REFERENCES teams(id),
    -- ONE AGENT PER VAULT. Two agents on one vault is two spend caps drawing on
    -- one pool of money, each blind to the other's spending; across companies
    -- it is one tenant signing with another's funds.
    fireblocks_vault_id  TEXT NOT NULL UNIQUE,
    address              TEXT NOT NULL,
    -- Integer base units (USDC has 6 decimals). Never a float: a spend cap
    -- that drifts by a rounding error is a money bug.
    spend_cap_base_units INTEGER NOT NULL,
    created_at           TEXT NOT NULL,
    -- An operator's stop button. NULL means not frozen — the single source of
    -- truth, deliberately not paired with a boolean that could drift out of
    -- sync with it. A frozen agent cannot pay at all, including redeeming an
    -- approval it already holds.
    frozen_at            TEXT,
    frozen_reason        TEXT,
    -- How hard the agent has pushed against the CURRENT freeze. Reset each
    -- time it is frozen, so the number always answers "is this agent
    -- respecting the stop?" rather than accumulating across unrelated
    -- incidents. A counter rather than a row per attempt: an agent in a retry
    -- loop would otherwise fill the payments table with rows describing one
    -- fact an operator already knows.
    frozen_attempt_count INTEGER NOT NULL DEFAULT 0,
    last_frozen_attempt_at TEXT,
    UNIQUE (team_id, name)
  )
`;

/**
 * Creates the one company and one team every agent hangs off, and retires the
 * old single-row `global_cap` table by carrying its value onto the company.
 *
 * The company cap IS the old global ceiling, renamed — not a second ceiling
 * beside it. There is exactly one company today; multi-company is deliberately
 * not built yet.
 *
 * The default team is seeded to the SAME carried-over value rather than to $0,
 * which is what a deliberately-created team would get. This team is created by
 * a migration, not by an operator: seeding it to $0 would hard-block every
 * existing agent at the team level the moment this ships, which looks exactly
 * like an outage despite nobody having lowered a cap. Carrying the value over
 * leaves enforcement behaviour identical immediately after the upgrade — the
 * team check is redundant at first, never more restrictive — and an operator
 * can tighten it deliberately afterwards.
 *
 * Runs exactly once: a non-empty `companies` table means it already ran.
 */
function seedDefaultCompanyAndRetireGlobalCap(): void {
  const now = new Date().toISOString();
  const companyId = randomUUID();
  const teamId = randomUUID();
  let carried = 0n;
  let hadGlobalCap: unknown;

  // The "has this already run?" check is INSIDE the transaction, not before
  // it. Read outside, two processes booting against the same file could both
  // see an empty table and both try to seed; the loser dies on the UNIQUE name
  // constraint mid-boot. IMMEDIATE takes the write lock before the read, so
  // the second process sees the first one's committed company and no-ops.
  db.exec("BEGIN IMMEDIATE");
  try {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM companies").get() as { n: number };
    if (Number(n) > 0) {
      db.exec("COMMIT");
      return;
    }

    hadGlobalCap = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'global_cap'")
      .get();

    // A fresh install with no prior global_cap starts at 0 — deny until an
    // operator grants budget, the same default global_cap itself was seeded to.
    if (hadGlobalCap) {
      const row = db
        .prepare("SELECT spend_cap_base_units AS cap FROM global_cap WHERE id = 1")
        .get() as { cap: number | bigint } | undefined;
      if (row) carried = BigInt(row.cap);
    }

    db.prepare(
      `INSERT INTO companies (id, name, spend_cap_base_units, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(companyId, "Default Company", carried, now);
    db.prepare(
      `INSERT INTO teams (id, company_id, name, spend_cap_base_units, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(teamId, companyId, "Default Team", carried, now);
    if (hadGlobalCap) db.exec("DROP TABLE global_cap");
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  }
  console.log(
    `[db] seeded default company + team; ` +
      `cap carried over from ${hadGlobalCap ? "global_cap" : "nothing (fresh install)"}: ` +
      `${carried} base units`,
  );
}

/**
 * Adds `agents.team_id` to a database created before the hierarchy existed.
 *
 * `CREATE TABLE IF NOT EXISTS` above silently does nothing when `agents`
 * already exists, so an older database keeps the column-less shape forever —
 * and every cap check would then fail its join and refuse to pay. SQLite
 * cannot add a NOT NULL column with no default to a populated table, so the
 * table is rebuilt, exactly as migratePaymentStatuses does.
 *
 * Existing agents are backfilled onto the default team, which
 * seedDefaultCompanyAndRetireGlobalCap has already created by this point.
 */
function migrateAgentsAddTeamId(): void {
  const columns = db.prepare("PRAGMA table_info('agents')").all() as unknown as { name: string }[];
  // No table at all means the CREATE above just made it in its final shape.
  if (columns.length === 0) return;
  if (columns.some((c) => c.name === "team_id")) return;

  const team = db.prepare("SELECT id FROM teams ORDER BY created_at LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (!team) {
    throw new Error("Cannot migrate agents: no team exists to backfill them onto");
  }
  // The rebuild below lands in the CURRENT shape, which refuses a shared vault.
  // Say so by name rather than dying on a bare constraint error mid-copy. Name
  // clashes cannot occur here: every name was globally unique in this shape.
  refuseAgentsTheNewConstraintsReject({ hasTeamId: false });

  // Foreign keys must be off for the drop/rename, and that pragma is a no-op
  // inside a transaction — so it goes outside.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(agentsTable("agents_migrated"));
    db.prepare(
      `INSERT INTO agents_migrated
         (id, name, team_id, fireblocks_vault_id, address, spend_cap_base_units, created_at)
       SELECT id, name, ?, fireblocks_vault_id, address, spend_cap_base_units, created_at
       FROM agents`,
    ).run(team.id);
    db.exec("DROP TABLE agents");
    db.exec("ALTER TABLE agents_migrated RENAME TO agents");
    db.exec("COMMIT");
    console.log(`[db] migrated agents to add team_id; backfilled onto team ${team.id}`);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    // `PRAGMA foreign_keys` is a silent no-op inside a transaction, so if both
    // COMMIT and ROLLBACK failed we would leave FK enforcement off for the
    // life of the process without noticing. Make that loud instead.
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }

  // Unlike the payments migration, this rebuilt a table that another table
  // REFERENCES (payments.agent_id). Ids are copied verbatim so nothing should
  // dangle, but a silent dangling reference here would mean payments that no
  // cap check can ever see again — so prove it instead of assuming it.
  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Refusing to continue: ${violations.length} foreign key violation(s) after migrating agents`,
    );
  }
}

/**
 * Adds the freeze columns to a database created before freezing existed.
 *
 * Notably NOT the rebuild dance the previous two migrations needed: both
 * columns are nullable with no default, which is the one shape SQLite's
 * `ALTER TABLE ADD COLUMN` handles directly. `migrateAgentsAddTeamId` had to
 * rebuild because SQLite cannot add a NOT NULL column to populated rows, and
 * `migrateApprovalScopes` because it cannot ALTER a CHECK constraint. Neither
 * constraint applies here, so the cheap path is also the correct one.
 *
 * Each column is added independently so a half-applied migration — process
 * killed between the two ALTERs — completes on the next boot rather than
 * leaving the table permanently short one column.
 */
function migrateAgentsAddFreezeColumns(): void {
  const columns = db.prepare("PRAGMA table_info('agents')").all() as unknown as { name: string }[];
  // No table at all means the CREATE above just made it in its final shape.
  if (columns.length === 0) return;

  const added: string[] = [];
  if (!columns.some((c) => c.name === "frozen_at")) {
    db.exec("ALTER TABLE agents ADD COLUMN frozen_at TEXT");
    added.push("frozen_at");
  }
  if (!columns.some((c) => c.name === "frozen_reason")) {
    db.exec("ALTER TABLE agents ADD COLUMN frozen_reason TEXT");
    added.push("frozen_reason");
  }
  // NOT NULL is allowed on ADD COLUMN only because a non-null constant default
  // comes with it — SQLite can then fill existing rows. Without the default
  // this would need the rebuild dance the other two migrations use.
  if (!columns.some((c) => c.name === "frozen_attempt_count")) {
    db.exec("ALTER TABLE agents ADD COLUMN frozen_attempt_count INTEGER NOT NULL DEFAULT 0");
    added.push("frozen_attempt_count");
  }
  if (!columns.some((c) => c.name === "last_frozen_attempt_at")) {
    db.exec("ALTER TABLE agents ADD COLUMN last_frozen_attempt_at TEXT");
    added.push("last_frozen_attempt_at");
  }
  if (added.length > 0) {
    console.log(`[db] added agent freeze column(s): ${added.join(", ")} (existing agents unfrozen)`);
  }
}

/**
 * Refuses, by name, the rows `UNIQUE (team_id, name)` and
 * `UNIQUE (fireblocks_vault_id)` would reject.
 *
 * REPORT AND REFUSE, NEVER NORMALISE -- the migrateQboConfigGrain rule. Both
 * fixes for a clash are judgement calls a migration has no business making:
 * which of two same-named agents gets renamed, and which of two agents keeps a
 * shared vault (the one holding the payment history? the older one?) and who
 * provisions the other a new one. A migration that picked would be moving
 * custody on a guess. So boot stops, and says exactly which rows and why.
 *
 * Ids and vault ids only: this reaches a server log, never a product surface.
 */
function refuseAgentsTheNewConstraintsReject({ hasTeamId }: { hasTeamId: boolean }): void {
  const problems: string[] = [];

  const sharedVaults = db
    .prepare(
      `SELECT fireblocks_vault_id AS vault, GROUP_CONCAT(id, ', ') AS ids
         FROM agents GROUP BY fireblocks_vault_id HAVING COUNT(*) > 1`,
    )
    .all() as unknown as { vault: string; ids: string }[];
  for (const row of sharedVaults) {
    problems.push(`vault ${row.vault} is held by more than one agent (${row.ids})`);
  }

  if (hasTeamId) {
    const clashes = db
      .prepare(
        `SELECT team_id, GROUP_CONCAT(id, ', ') AS ids
           FROM agents GROUP BY team_id, name HAVING COUNT(*) > 1`,
      )
      .all() as unknown as { team_id: string; ids: string }[];
    for (const row of clashes) {
      problems.push(`team ${row.team_id} has more than one agent with the same name (${row.ids})`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to migrate agents: ${problems.join("; ")}. ` +
        "Nothing was changed. Each clash needs a decision a migration cannot make " +
        "(which agent keeps the vault, or the name); see docs/shared-vault-remediation.md.",
    );
  }
}

/** The column sets of every UNIQUE index on a table, read from SQLite itself. */
function uniqueColumnSets(table: string): string[][] {
  const indexes = db.prepare(`PRAGMA index_list('${table}')`).all() as unknown as {
    name: string;
    unique: number | bigint;
    partial: number | bigint;
  }[];
  return indexes
    .filter((index) => Number(index.unique) === 1 && Number(index.partial) === 0)
    .map((index) =>
      (
        db.prepare(`PRAGMA index_info('${index.name}')`).all() as unknown as {
          seqno: number | bigint;
          name: string;
        }[]
      )
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((column) => column.name),
    );
}

/**
 * Agent names become unique per team; vaults become one per agent.
 *
 * WHY THESE TWO LAND TOGETHER. `provisionAgentWallet` is idempotent BY VAULT
 * NAME: asked for a name that already exists at Fireblocks, it hands back that
 * vault. Vaults used to be named `fuel-agent-<agent name>`, and the global
 * UNIQUE on `agents.name` was the only thing making that one-to-one. Loosening
 * the name alone would have given company B's "researcher" company A's vault --
 * no error, B signing with A's money. The route now names vaults after the
 * agent's id instead, and the vault UNIQUE here is the backstop that makes a
 * second agent on one vault impossible to write at all, whatever a provisioner
 * returns.
 *
 * Detected from `PRAGMA index_list`/`index_info`, not by pattern-matching the
 * DDL text: whitespace, quoting and comments in the stored SQL are not a
 * contract, and the auto-index's columns are.
 *
 * The rebuild follows migrateAgentsAddTeamId exactly: FK enforcement off
 * outside the transaction (the pragma is a no-op inside one), every column
 * named on both sides so nothing maps positionally, then enforcement restored,
 * read back, and every reference proved intact -- five tables point at agents.
 */
function migrateAgentsUniquePerTeamAndVault(): void {
  const columns = db.prepare("PRAGMA table_info('agents')").all() as unknown as { name: string }[];
  if (columns.length === 0) return;

  const sets = uniqueColumnSets("agents").map((set) => set.join(","));
  const done =
    sets.includes("team_id,name") &&
    sets.includes("fireblocks_vault_id") &&
    !sets.includes("name");
  if (done) return;

  refuseAgentsTheNewConstraintsReject({ hasTeamId: true });

  const copied =
    "id, name, team_id, fireblocks_vault_id, address, spend_cap_base_units, created_at, " +
    "frozen_at, frozen_reason, frozen_attempt_count, last_frozen_attempt_at";

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("DROP TABLE IF EXISTS agents_migrated");
    db.exec(agentsTable("agents_migrated"));
    db.exec(`INSERT INTO agents_migrated (${copied}) SELECT ${copied} FROM agents`);
    const before = db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number };
    const after = db.prepare("SELECT COUNT(*) AS n FROM agents_migrated").get() as { n: number };
    if (Number(before.n) !== Number(after.n)) {
      throw new Error(`agents rebuild copied ${after.n} of ${before.n} rows`);
    }
    db.exec("DROP TABLE agents");
    db.exec("ALTER TABLE agents_migrated RENAME TO agents");
    // Dropped with the old table. Recreated here as well as at the bottom of
    // this file so the rebuild is complete on its own terms.
    db.exec("CREATE INDEX IF NOT EXISTS agents_team_idx ON agents(team_id)");
    db.exec("COMMIT");
    console.log(
      `[db] migrated agents: names unique per team, one agent per vault (${after.n} agent(s) carried over)`,
    );
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Refusing to continue: ${violations.length} foreign key violation(s) after migrating agents`,
    );
  }
}

/**
 * Adds `settled_at` to an existing payments table.
 *
 * Takes the cheap ADD COLUMN path rather than the rebuild dance below: the
 * column is nullable with no default, which SQLite can add in place. Existing
 * settled rows keep NULL, which is the honest answer — nothing recorded when
 * they settled, so there is nothing to backfill from.
 */
function migratePaymentsAddSettledAt(): void {
  const columns = db.prepare("PRAGMA table_info('payments')").all() as unknown as { name: string }[];
  // No table at all means the CREATE above just made it in its final shape.
  if (columns.length === 0) return;
  if (columns.some((c) => c.name === "settled_at")) return;

  db.exec("ALTER TABLE payments ADD COLUMN settled_at TEXT");
  console.log("[db] added payments.settled_at (existing settled rows keep NULL)");
}

/**
 * Adds a nullable annotation column in place.
 *
 * The cheap ADD COLUMN path, the same one migratePaymentsAddSettledAt takes:
 * nullable with no default, or NOT NULL with a CONSTANT default, are the two
 * shapes SQLite can add without rebuilding a table. Both of this slice's
 * columns are one of those, which is why neither touches the money table's
 * structure or its foreign keys.
 *
 * Idempotent: a second run sees the column and returns.
 */
function addColumnIfMissing(table: string, column: string, definition: string, note: string): void {
  const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as unknown as {
    name: string;
  }[];
  // No table at all means the CREATE above just made it in its final shape.
  if (columns.length === 0) return;
  if (columns.some((c) => c.name === column)) return;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  console.log(`[db] added ${table}.${column} (${note})`);
}

/**
 * Which company the legacy FUEL_API_KEY / FUEL_AGENT_KEY credentials act for.
 *
 * RECORDED, NOT RE-DERIVED ON EVERY BOOT. Until 7A-1 the answer was
 * `getDefaultCompany()` -- the oldest row in `companies` -- which is correct
 * with one company and silently wrong with two: it does not error, it serves
 * the first tenant's data to whoever holds the key. Recomputing "the only
 * company" at each boot would repeat that mistake more politely, because the
 * day a second company exists the answer stops being derivable at all.
 *
 * So it is written down exactly once, while it is still unambiguous. A single
 * row, enforced by the CHECK, so there is never a question of which binding
 * applies.
 *
 * NOTHING IS GUESSED. If this runs against a database that already holds more
 * than one company and has no recorded binding, the row is left absent and
 * `bootstrapCompany()` refuses loudly at boot. Picking one -- by age, by name,
 * by anything -- is precisely the silent answer this table replaces.
 */
function recordBootstrapCompany(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bootstrap_company (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      company_id  TEXT NOT NULL REFERENCES companies(id),
      recorded_at TEXT NOT NULL
    )
  `);

  // Inside one IMMEDIATE transaction for the same reason the seed above is:
  // two processes booting together must not both decide.
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT 1 FROM bootstrap_company WHERE id = 1").get();
    const companies = db.prepare("SELECT id FROM companies").all() as unknown as { id: string }[];
    if (existing || companies.length !== 1) {
      db.exec("COMMIT");
      return;
    }
    db.prepare(
      "INSERT INTO bootstrap_company (id, company_id, recorded_at) VALUES (1, ?, ?)",
    ).run(companies[0]!.id, new Date().toISOString());
    db.exec("COMMIT");
    console.log("[db] recorded the bootstrap company for the legacy credentials");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  }
}

seedDefaultCompanyAndRetireGlobalCap();
recordBootstrapCompany();
db.exec(agentsTable("IF NOT EXISTS agents"));
migrateAgentsAddTeamId();
migrateAgentsAddFreezeColumns();
migrateAgentsUniquePerTeamAndVault();

db.exec(paymentsTable("IF NOT EXISTS payments"));
migratePaymentsAddSettledAt();
addColumnIfMissing(
  "payments",
  "refusal_code",
  "refusal_code TEXT",
  "existing refusals keep NULL — their reason is unavailable, not guessed",
);
addColumnIfMissing(
  "payments",
  "is_demo",
  "is_demo INTEGER NOT NULL DEFAULT 0",
  "every existing row starts as real; scripts/mark-demo-rows.ts marks demo rows deliberately",
);
/*
 * When the signed authorization stops being spendable, as a unix timestamp in
 * seconds, read from the authorization Fuel actually signed.
 *
 * ADDED IN 6B-2 TO MAKE A BUDGET RELEASE CHECKABLE. Reconciling an
 * unreconciled payment to `failed` releases its budget, and that is only sound
 * when no spendable authorization exists. Without this column the operator's
 * word was the only evidence, and a mistaken (or coerced) attestation would
 * release budget against an authorization the facilitator could still settle --
 * real spend exceeding the cap, silently and unrecoverably, because nothing
 * ever revisits a `failed` row.
 *
 * NULL on every row written before this existed, and that is not treated as
 * "expired". reconcileUnreconciledPayment refuses `failed` while a recorded
 * window is still open, and reports a NULL window as unverified rather than
 * pretending it checked -- the same distinction 0008 forced for currency.
 */
addColumnIfMissing(
  "payments",
  "authorization_valid_before",
  "authorization_valid_before INTEGER",
  "rows signed before 6B-2 keep NULL; their expiry is unknown, not assumed past",
);

/**
 * A payment refused by the team or company ceiling, held for a human decision.
 *
 * Only the team and company ceilings produce these. An agent over its OWN cap
 * is a hard block: the agent cap is the narrowest, and a payment that cannot
 * fit the budget its own operator set for it is not an exception worth asking
 * about.
 *
 * Nothing here holds budget. A request is not a reservation — no money can
 * move until an approved request is redeemed by a real payment, which reserves
 * in the ordinary way.
 *
 * Why an approval cannot simply hold a signed authorization while it waits:
 * x402 stamps `validBefore` before signing and the MERCHANT picks the window
 * (see src/payments/limits.ts — we refuse anything under 120s). A human
 * decision takes minutes to days, so the signature would expire in the queue.
 * The pause therefore happens before anything is signed, and redemption
 * re-fetches the merchant's terms and signs fresh.
 */
const APPROVAL_STATUSES = ["pending", "approved", "denied", "consumed", "expired"];
const APPROVAL_STATUS_CHECK = APPROVAL_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * What a request is asking permission for — and therefore what approving it
 * exempts. Never 'agent': see above.
 *
 * 'anomaly' is NOT a ceiling. It means the payment passed every cap and was
 * still held because its size was out of character for the agent
 * (src/payments/anomaly.ts). The distinction is load-bearing at redemption:
 * a team/company approval exempts those ceilings, an anomaly approval exempts
 * only the anomaly rule and is still subject to every cap. Collapsing the two
 * would mean an operator waving through an odd-looking payment silently also
 * waived the team's budget ceiling.
 */
const APPROVAL_SCOPES = ["team", "company", "anomaly"];
const APPROVAL_SCOPE_CHECK = APPROVAL_SCOPES.map((s) => `'${s}'`).join(", ");

const approvalRequestsTable = (name: string) => `
  CREATE TABLE ${name} (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL REFERENCES agents(id),
    amount_base_units   INTEGER NOT NULL,
    resource_url        TEXT NOT NULL,
    -- Which ceiling refused it, or 'anomaly'. Never 'agent' — see above.
    blocked_scope       TEXT NOT NULL CHECK (blocked_scope IN (${APPROVAL_SCOPE_CHECK})),
    -- pending:  awaiting a human.
    -- approved: redeemable, once, until approval_expires_at.
    -- denied:   refused by a human. Terminal.
    -- consumed: a payment redeemed it. Terminal — this is what makes an
    --           approval single-use, and it is set inside the same
    --           transaction that reserves the payment's budget.
    -- expired:  never acted on, or approved and never redeemed in time.
    status              TEXT NOT NULL CHECK (status IN (${APPROVAL_STATUS_CHECK})),
    -- Set when approved; the deadline the reaper enforces.
    approval_expires_at TEXT,
    -- Set when consumed, linking the approval to the payment that spent it.
    payment_id          TEXT REFERENCES payments(id),
    created_at          TEXT NOT NULL,
    decided_at          TEXT,
    detail              TEXT,
    -- See payments.is_demo. Same marker, same reasoning, same guarantee that
    -- no production write path can set it.
    is_demo             INTEGER NOT NULL DEFAULT 0
  )
`;

db.exec(approvalRequestsTable("IF NOT EXISTS approval_requests"));

/**
 * Widens `approval_requests.blocked_scope` to accept 'anomaly'.
 *
 * Same shape of problem as migratePaymentStatuses: `CREATE TABLE IF NOT EXISTS`
 * does nothing to an existing table, so a database created before anomaly
 * detection keeps the two-value CHECK. Inserting an anomaly request would then
 * throw — and that throw happens on the refusal path of a payment that already
 * passed every cap, so the agent would get a 500 instead of a held payment.
 *
 * SQLite cannot ALTER a CHECK constraint, so the table is rebuilt.
 */
function migrateApprovalScopes(): void {
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approval_requests'")
    .get() as { sql: string } | undefined;

  if (!existing) return;

  // Match the CHECK clause, not the whole DDL — the comments above name every
  // scope, so a substring search would report "already migrated" for a table
  // that is not. Same trap migratePaymentStatuses documents.
  const checkClause =
    existing.sql.match(/CHECK\s*\(\s*blocked_scope\s+IN\s*\(([^)]*)\)/i)?.[1] ?? "";
  if (APPROVAL_SCOPES.every((scope) => checkClause.includes(`'${scope}'`))) return;

  // Foreign keys must be off for the drop/rename, and that pragma is a no-op
  // inside a transaction — so it goes outside.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(approvalRequestsTable("approval_requests_migrated"));
    db.exec(`
      INSERT INTO approval_requests_migrated
        (id, agent_id, amount_base_units, resource_url, blocked_scope, status,
         approval_expires_at, payment_id, created_at, decided_at, detail)
      SELECT id, agent_id, amount_base_units, resource_url, blocked_scope, status,
             approval_expires_at, payment_id, created_at, decided_at, detail
      FROM approval_requests;
    `);
    db.exec("DROP TABLE approval_requests");
    db.exec("ALTER TABLE approval_requests_migrated RENAME TO approval_requests");
    db.exec("COMMIT");
    console.log("[db] migrated approval_requests.blocked_scope to include: " + APPROVAL_SCOPES.join(", "));
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    // `PRAGMA foreign_keys` is a silent no-op inside a transaction, so if both
    // COMMIT and ROLLBACK failed we would leave FK enforcement off for the
    // life of the process without noticing. Make that loud instead.
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }

  // This table REFERENCES payments(id) and agents(id). Ids are copied verbatim,
  // but a silently dangling payment_id would break the only link between an
  // approval and the payment that spent it — the audit trail the whole approval
  // mechanism exists to produce. Prove it rather than assume it.
  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Refusing to continue: ${violations.length} foreign key violation(s) after migrating approval_requests`,
    );
  }
}

migrateApprovalScopes();
addColumnIfMissing(
  "approval_requests",
  "is_demo",
  "is_demo INTEGER NOT NULL DEFAULT 0",
  "every existing row starts as real; scripts/mark-demo-rows.ts marks demo rows deliberately",
);

/**
 * Bring an older payments table up to the current status set.
 *
 * `CREATE TABLE IF NOT EXISTS` silently does nothing when the table already
 * exists, so a database created before a status was added keeps the old CHECK
 * constraint forever. That is not cosmetic: writing `unreconciled` to such a
 * database throws, and `unreconciled` is the mechanism that keeps budget
 * consumed for a payment that was signed but whose outcome we never saw.
 * A constraint violation there would strand the row in `pending`, where the
 * reaper would later release the budget — the precise overspend the status
 * exists to prevent.
 *
 * SQLite cannot ALTER a CHECK constraint, so the table is rebuilt.
 */
function migratePaymentStatuses(): void {
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payments'")
    .get() as { sql: string } | undefined;

  if (!existing) return;

  // Match the CHECK clause itself, not the whole DDL. SQLite stores the
  // comments above verbatim, and those comments name every status — so a
  // substring search over the full text is one comment edit away from
  // reporting "already migrated" for a table that is not, silently restoring
  // the exact bug this function exists to fix.
  const checkClause = existing.sql.match(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i)?.[1] ?? "";
  if (PAYMENT_STATUSES.every((status) => checkClause.includes(`'${status}'`))) return;

  // Foreign keys must be off for the drop/rename, and that pragma is a no-op
  // inside a transaction — so it goes outside.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(paymentsTable("payments_migrated"));
    // Both lists are explicit, so EVERY column added to paymentsTable() must be
    // added here too. A column missing from this copy is not an error — the
    // rebuild succeeds and silently returns NULLs for it, which for settled_at
    // would mean quietly re-dating every historical transaction in the
    // accounting export.
    db.exec(`
      INSERT INTO payments_migrated
        (id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at,
         settled_at)
      SELECT id, agent_id, amount_base_units, resource_url, status, tx_hash, detail, created_at,
         settled_at
      FROM payments;
    `);
    db.exec("DROP TABLE payments");
    db.exec("ALTER TABLE payments_migrated RENAME TO payments");

    // Any `pending` row predating this migration is suspect. On the old schema
    // `markUnreconciled` threw (the status did not exist), so a payment that
    // was signed and then failed was left stranded in `pending` — where its
    // budget happened to stay consumed. Now that the reaper exists it would
    // read those as "never signed" and release them. Assume the worst, exactly
    // as the live path does after signing.
    const { changes } = db
      .prepare(
        `UPDATE payments SET status = 'unreconciled', detail = ?
         WHERE status = 'pending'`,
      )
      .run("pending across a schema migration; cannot prove it was never signed");

    db.exec("COMMIT");
    console.log("[db] migrated payments.status to include: " + PAYMENT_STATUSES.join(", "));
    if (Number(changes) > 0) {
      console.log(`[db] reclassified ${changes} pre-existing pending payment(s) as unreconciled`);
    }
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    // `PRAGMA foreign_keys` is a silent no-op inside a transaction, so if both
    // COMMIT and ROLLBACK failed we would leave FK enforcement off for the
    // life of the process without noticing. Make that loud instead.
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }
}

migratePaymentStatuses();

/**
 * The accounting rollup: what has been posted to the books, and out of what.
 *
 * Two tables, both new, so both take the plain `CREATE TABLE IF NOT EXISTS`
 * path. There is deliberately no migration function beside them — unlike the
 * last three slices nothing existing changes shape, so there is no CHECK to
 * widen and no NOT NULL column to backfill. Ceremony that is not needed is
 * ceremony that can go wrong.
 *
 * Why these exist at all: every payment Fuel has made is $0.001 and accounting
 * systems store two decimals, so posting one-to-one books $0.00. Spend instead
 * accumulates per (agent, vendor, class) until it crosses a whole cent. See
 * docs/decisions/0007-accounting-integration-posting-model.md.
 *
 * NOTHING HERE STORES A RESIDUAL. The amount still waiting to clear is derived
 * — owed (from `payments`) minus posted (from `export_postings`) — for the same
 * reason spentBaseUnits is derived rather than kept as a running total on the
 * agent: a stored counter can drift out of step with what actually happened,
 * and a counter decremented by a run that then crashed before writing its line
 * would silently delete money from the books. See src/db/postings.ts.
 */
const postingLinesTable = (name: string) => `
  CREATE TABLE ${name} (
    id                  TEXT PRIMARY KEY,
    -- Groups every line produced by one posting run, so a run can be reviewed
    -- or explained as a unit. Not a foreign key: there is no runs table, and
    -- inventing one before anything consumes it would be schema for its own
    -- sake.
    run_id              TEXT NOT NULL,
    agent_id            TEXT NOT NULL REFERENCES agents(id),
    -- WHO THE OTHER PARTY WAS. Named counterparty rather than vendor_host
    -- because revenue has no vendor: the money came FROM someone. For spend
    -- this is the resource URL's host, exactly as src/lib/export-presentation.ts
    -- derives it for the CSV, so an accountant's vendor mapping cannot silently
    -- mean two different things in two exports. For revenue it is the earning
    -- endpoint the money arrived through, which is also the right residual
    -- bucket: sub-cent revenue at one endpoint should accumulate until it
    -- clears a cent, exactly as sub-cent spend at one vendor does.
    --
    -- Still NOT NULL. Every line has a counterparty of one kind or the other;
    -- nullable would only mean "we did not decide". See 0012.
    counterparty        TEXT NOT NULL,
    -- YYYY-MM-DD: the ledger day of the NEWEST payment this line absorbed.
    -- Derived from the data, never from the clock, so re-running the engine
    -- reproduces the same date.
    posting_day         TEXT NOT NULL,
    -- expense:  the payment settled; a real cost.
    -- suspense: the payment is unreconciled — signed, so the money may have
    --           moved, but no settlement was ever seen. Held apart rather than
    --           booked as paid, because claiming it either way would be a
    --           statement Fuel cannot support.
    -- revenue:  money Fuel witnessed ARRIVING, sourced from receipts rather
    --           than payments. The one class whose source is a different
    --           table, which is why the integrity checks in db/postings.ts run
    --           once per direction instead of summing across classes.
    --
    -- There is deliberately no revenue-suspense: inbound fails closed the other
    -- way, so an unconfirmed receipt does not post at all. See db/receipts.ts.
    --
    -- Adding a class needs the table rebuilt: SQLite cannot ALTER a CHECK
    -- constraint. migrateApprovalScopes above is the worked example, and
    -- migratePostingLineClasses below is this column's own.
    ledger_class        TEXT NOT NULL CHECK (ledger_class IN (${LEDGER_CLASS_CHECK})),
    -- Always an exact multiple of one cent (10000 base units).
    --
    -- MAY BE NEGATIVE, and that is not an error case: a negative suspense line
    -- is the credit half of a reclassification, released when an unreconciled
    -- payment finally settles and the suspense bucket no longer owes what it
    -- has already posted.
    amount_base_units   INTEGER NOT NULL,
    created_at          TEXT NOT NULL
  )
`;

db.exec(postingLinesTable("IF NOT EXISTS posting_lines"));

/**
 * Brings an older posting_lines up to the current class set and column names.
 *
 * Two changes at once, both needing a rebuild, so they share one: the
 * `ledger_class` CHECK gains 'revenue' (SQLite cannot ALTER a CHECK), and
 * `vendor_host` becomes `counterparty` because revenue has no vendor.
 *
 * Doing them together is deliberate. Two sequential rebuilds of the same table
 * means two windows in which a crash leaves a half-migrated schema, and this
 * table is referenced by export_postings under PRAGMA foreign_keys = ON.
 *
 * The detection reads the CHECK clause rather than searching the whole DDL,
 * for the reason migrateApprovalScopes documents: the comments in this table's
 * own definition name every class, so a substring search would report "already
 * migrated" for a table that is not.
 */
function migratePostingLineClasses(): void {
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'posting_lines'")
    .get() as { sql: string } | undefined;

  if (!existing) return;

  const checkClause =
    existing.sql.match(/CHECK\s*\(\s*ledger_class\s+IN\s*\(([^)]*)\)/i)?.[1] ?? "";
  const classesCurrent = LEDGER_CLASSES_DDL.every((c) => checkClause.includes(`'${c}'`));
  const columnsCurrent = (
    db.prepare("PRAGMA table_info('posting_lines')").all() as unknown as { name: string }[]
  ).some((c) => c.name === "counterparty");
  if (classesCurrent && columnsCurrent) return;

  // Foreign keys must be off for the drop/rename, and that pragma is a no-op
  // inside a transaction — so it goes outside.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(postingLinesTable("posting_lines_migrated"));
    // vendor_host carries over verbatim into counterparty: for spend the value
    // means exactly what it always did. Only the name widens, to admit a
    // counterparty that is not a vendor.
    db.exec(`
      INSERT INTO posting_lines_migrated
        (id, run_id, agent_id, counterparty, posting_day, ledger_class,
         amount_base_units, created_at)
      SELECT id, run_id, agent_id, ${columnsCurrent ? "counterparty" : "vendor_host"},
             posting_day, ledger_class, amount_base_units, created_at
      FROM posting_lines;
    `);
    db.exec("DROP TABLE posting_lines");
    db.exec("ALTER TABLE posting_lines_migrated RENAME TO posting_lines");
    db.exec("COMMIT");
    console.log(
      "[db] migrated posting_lines: ledger_class now " +
        LEDGER_CLASSES_DDL.join("/") +
        ", vendor_host renamed to counterparty",
    );
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    // `PRAGMA foreign_keys` is a silent no-op inside a transaction, so if both
    // COMMIT and ROLLBACK failed we would leave FK enforcement off for the
    // life of the process without noticing. Make that loud instead.
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }

  // export_postings.line_id references this table. Ids are copied verbatim, but
  // a silently dangling line_id would break the link between a posted amount
  // and the payments beneath it — the audit trail the rollup exists to produce.
  // Prove it rather than assume it.
  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Refusing to continue: ${violations.length} foreign key violation(s) after migrating posting_lines`,
    );
  }
}

/**
 * An API a customer already serves, that Fuel fronts with a paywall.
 *
 * OWNED BY AN AGENT, not a team or a company, so "is this agent profitable?"
 * is a join on one id — see 0011. The company join path is the existing one:
 * earning_endpoints -> agents -> teams -> company_id.
 *
 * Two independent checks gate `enabled`, and they answer different questions:
 * ownership proof asks "does this operator control the origin?" (which is what
 * stops Fuel being pointed at a third party as a relay), and the bypass probes
 * ask "does the origin actually refuse traffic that did not come through
 * Fuel?" (which is what makes the paywall real rather than asserted). Neither
 * substitutes for the other, and `enabled` may not be set true without both.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS earning_endpoints (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL REFERENCES agents(id),
    -- The path segment Fuel serves this on. High-entropy and Fuel-issued: it is
    -- never derived from the origin hostname, because the origin URL is
    -- infrastructure detail and a payer has no reason to learn it.
    public_id           TEXT NOT NULL UNIQUE,
    -- Exactly one URL. No caller-supplied path segments are ever appended --
    -- that is what would turn /earn/<id>/../../admin into a real request.
    origin_url          TEXT NOT NULL,
    -- WHAT AN ACCOUNTANT CALLS THIS ENDPOINT. It becomes
    -- posting_lines.counterparty on every revenue line and lands in a
    -- QuickBooks-facing CSV, which is why it is bounded and screened at the
    -- write path rather than accepted as free text -- see assertUsableLabel in
    -- db/earning-endpoints.ts. Neither the public_id nor the row id can do this
    -- job: one is high-entropy base64url and the other a UUID, and a column
    -- headed "Counterparty" standing over either is not a counterparty. 0012.
    --
    -- NOT NULL here applies to freshly created databases only; an existing one
    -- gets the column by ALTER TABLE, which cannot carry the constraint. The
    -- authority for both is the write path, the same split
    -- migrateQboConfigAddCurrency already reasons about for its own CHECKs.
    label               TEXT NOT NULL,
    price_base_units    INTEGER NOT NULL,
    -- Encrypted at rest via lib/secrets.ts, same as the QuickBooks tokens. Fuel
    -- signs each forwarded request with this so the origin can tell Fuel's
    -- traffic from anyone else's.
    forward_secret      TEXT NOT NULL,
    -- OWNERSHIP PROOF. Distinct from the per-request HMAC nonce in the gateway,
    -- which is a different thing with a similar name: this one is issued once
    -- per registration and must be echoed by the origin at a well-known path.
    ownership_nonce     TEXT NOT NULL,
    ownership_proved_at TEXT,
    -- The address the origin resolved to when ownership was last proved. An
    -- operator can prove ownership once and then repoint DNS at a host they do
    -- not control; recording this makes that change detectable.
    ownership_address   TEXT,
    -- BYPASS PROBES, both of them. The first sends no signature headers at all.
    -- The second sends the correct header NAMES with an invalid signature --
    -- without it, an origin that merely checks the header is PRESENT would pass,
    -- and the header names are not secret, so any caller could then walk
    -- straight through with a garbage value.
    probe_unsigned_at   TEXT,
    probe_bad_sig_at    TEXT,
    -- Why the endpoint is not enabled, in words an operator can act on.
    blocked_reason      TEXT,
    enabled             INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS earning_endpoints_agent_idx ON earning_endpoints(agent_id)");

/**
 * Gives every pre-existing endpoint a label, then makes labels unique per agent.
 *
 * TWO MECHANISMS, NOT ONE, and the second is the one that is easy to get wrong.
 * `ALTER TABLE ADD COLUMN` can add the column but cannot carry a multi-column
 * table constraint, so `UNIQUE (agent_id, label)` has to arrive separately as
 * an index. SQLite will build that index without a table rebuild -- but only if
 * no existing rows already violate it.
 *
 * WHICH THEY CAN. `origin_url` has no uniqueness constraint, so one agent may
 * legitimately hold two endpoints against the same URL at different prices --
 * re-registering after a mistake produces exactly that. Both would derive the
 * same label from host+path, CREATE UNIQUE INDEX would fail, and the failure
 * would land at boot on a customer's database rather than here. So collisions
 * are resolved during the backfill instead of discovered afterwards.
 *
 * The derived label is a starting point an operator is expected to change, not
 * a claim about what the endpoint should be called. It is chosen to be
 * recognisable -- "api.acme.com/forecast" -- rather than unique-looking.
 */
function migrateEarningEndpointsAddLabel(): void {
  addColumnIfMissing(
    "earning_endpoints",
    "label",
    "label TEXT",
    "derived from the origin for existing endpoints; rename it to whatever the books should say",
  );

  const rows = db
    .prepare(
      `SELECT id, agent_id, origin_url FROM earning_endpoints
        WHERE label IS NULL OR trim(label) = ''
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as unknown as { id: string; agent_id: string; origin_url: string }[];
  if (rows.length === 0) return;

  // Seeded with the labels already in use, so a backfill running alongside rows
  // an operator has already named cannot collide with them either.
  const taken = new Map<string, Set<string>>();
  for (const row of db
    .prepare("SELECT agent_id, label FROM earning_endpoints WHERE label IS NOT NULL")
    .all() as unknown as { agent_id: string; label: string }[]) {
    const set = taken.get(row.agent_id) ?? new Set<string>();
    set.add(row.label.toLowerCase());
    taken.set(row.agent_id, set);
  }

  const update = db.prepare("UPDATE earning_endpoints SET label = ? WHERE id = ?");
  for (const row of rows) {
    const set = taken.get(row.agent_id) ?? new Set<string>();
    // deriveLabel is the SAME function registration uses, which is the point.
    // It parses the URL, truncates to the bound, and runs the result through
    // assertUsableLabel -- falling back to a generic name when the derived one
    // would be refused. This used to truncate and nothing else, so an origin
    // path carrying an MD5 or a git SHA wrote a hash-shaped string into an
    // accounting export. See lib/endpoint-label.ts.
    const base = deriveLabel(row.origin_url);

    let candidate = base;
    for (let n = 2; set.has(candidate.toLowerCase()); n += 1) {
      candidate = deriveLabel(row.origin_url, ` (${n})`);
    }
    set.add(candidate.toLowerCase());
    taken.set(row.agent_id, set);
    update.run(candidate, row.id);
  }
  console.log(`[db] labelled ${rows.length} earning endpoint(s) from their origin URLs`);
}

migrateEarningEndpointsAddLabel();

/**
 * One label per agent. See migrateEarningEndpointsAddLabel for why this is an
 * index rather than a table constraint, and why the backfill has to run first.
 */
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS earning_endpoints_label_idx
     ON earning_endpoints(agent_id, label)`,
);

/**
 * Money arriving. The inbound counterpart to `payments`.
 *
 * Created empty in 6A-1 because export_postings.receipt_id references it;
 * rebuilt here in 6A-2 now that the gateway knows what it actually has to
 * record. Rebuilding cost nothing precisely because it was empty, which was the
 * reason for creating it early.
 *
 * THE UNIQUE PAIR IS THE REPLAY DEFENCE, and it is load-bearing. The x402
 * resource-server path has no nonce store, no idempotency and no dedup of any
 * kind, so N concurrent requests replaying one signed payload all pass verify
 * and all reach the origin. Inserting a receipt BEFORE forwarding makes the
 * database the lock: the second insert violates this constraint and is refused
 * without the origin ever being touched.
 *
 * GLOBAL, NOT PER ENDPOINT. An EIP-3009 nonce is one-time-use per `from`
 * address regardless of who is being paid, so scoping it per endpoint would let
 * one authorization be replayed once against every endpoint registered.
 */
const receiptsTable = (name: string) => `
  CREATE TABLE ${name} (
    id                  TEXT PRIMARY KEY,
    -- Which agent earned it. The join path to a company is the same one every
    -- other scoped read uses: receipts -> agents -> teams -> company_id.
    agent_id            TEXT NOT NULL REFERENCES agents(id),
    endpoint_id         TEXT REFERENCES earning_endpoints(id),
    -- Integer base units, never a float, for the same reason a cap is not one.
    amount_base_units   INTEGER NOT NULL,
    status              TEXT NOT NULL CHECK (status IN (${RECEIPT_STATUS_CHECK})),
    -- The payer and the authorization they signed. Together these are the
    -- replay key; see the UNIQUE below.
    payer_address       TEXT NOT NULL,
    authorization_nonce TEXT NOT NULL,
    -- The settlement reference, once there is one. NULL until then.
    tx_hash             TEXT,
    -- Why a receipt ended where it did, for the states that are not self
    -- explanatory -- an origin timeout, a settlement error reason.
    detail              TEXT,
    -- When Fuel first saw the request, as distinct from when the money was
    -- confirmed -- the same two-timestamp split payments makes, for the same
    -- reason: "we saw it" and "it happened" are different events and a ledger
    -- wants the second.
    created_at          TEXT NOT NULL,
    settled_at          TEXT,
    UNIQUE (payer_address, authorization_nonce)
  )
`;

db.exec(receiptsTable("IF NOT EXISTS receipts"));
db.exec("CREATE INDEX IF NOT EXISTS receipts_agent_idx ON receipts(agent_id)");
db.exec("CREATE INDEX IF NOT EXISTS receipts_status_idx ON receipts(status, created_at)");

/**
 * Which sources a posted line was made of, and how much of each it took.
 *
 * This is the table that makes the rollup a ledger rather than a total. Without
 * it a posted $0.02 is an assertion; with it, that $0.02 resolves to the exact
 * payments beneath it, each of which resolves in turn to the agent that made it
 * and — through approval_requests.payment_id — to the human decision that
 * authorized it.
 *
 * `absorbed_base_units` rather than bare membership because absorption is
 * PARTIAL: a line posts a whole number of cents, so the last payment it reaches
 * is usually split across two lines. It may also be negative, unwinding an
 * earlier absorption when a payment changes class.
 *
 * POLYMORPHIC: a line absorbs payments (spend) or receipts (revenue), never
 * both, enforced by the CHECK. Exactly one of the two id columns is set.
 *
 * WHY NOT A NULLABLE PRIMARY KEY. The obvious move is to keep
 * `PRIMARY KEY (payment_id, line_id)` and let payment_id be null for revenue.
 * That silently stops working: SQLite permits NULLs in a PRIMARY KEY on a
 * non-INTEGER column in a non-STRICT table, so every revenue row would have a
 * NULL payment_id and the uniqueness guarantee — the thing this key exists for
 * — would evaporate with no error at all. Verified empirically, not assumed:
 * two identical (NULL, line) rows insert happily.
 *
 * So the guarantee is carried by two PARTIAL unique indexes instead, one per
 * source, each covering only the rows where its own id is present. That keeps
 * exactly the property the composite key had — one source may span many lines
 * (the partial-absorption case) but cannot be absorbed twice by the same line —
 * for both source kinds. See 0012.
 */
const exportPostingsTable = (name: string) => `
  CREATE TABLE ${name} (
    payment_id          TEXT REFERENCES payments(id),
    receipt_id          TEXT REFERENCES receipts(id),
    line_id             TEXT NOT NULL REFERENCES posting_lines(id),
    absorbed_base_units INTEGER NOT NULL,
    CHECK ((payment_id IS NULL) <> (receipt_id IS NULL))
  )
`;

/**
 * The uniqueness guarantee, carried by partial indexes instead of a key.
 *
 * A function because a table rebuild drops its indexes along with it, so these
 * have to be creatable on both paths — initial create and post-migration —
 * from one definition rather than two that could drift.
 */
function createExportPostingsIndexes(): void {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS export_postings_payment_line
      ON export_postings (payment_id, line_id) WHERE payment_id IS NOT NULL;
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS export_postings_receipt_line
      ON export_postings (receipt_id, line_id) WHERE receipt_id IS NOT NULL;
  `);
}

db.exec(exportPostingsTable("IF NOT EXISTS export_postings"));

/**
 * Rebuilds an older export_postings into the polymorphic shape.
 *
 * The old table was `payment_id NOT NULL` with `PRIMARY KEY (payment_id,
 * line_id)`. Both have to go: a receipt-sourced absorption has no payment id,
 * and a nullable column inside a PRIMARY KEY stops guaranteeing uniqueness in
 * SQLite without saying so.
 *
 * Every existing row is spend, so payment_id carries over verbatim and
 * receipt_id is NULL — which satisfies the new CHECK by construction rather
 * than by hope. The count is asserted afterwards because this table IS the
 * audit trail: losing a row here would silently detach posted money from the
 * payment that justified it, and the conservation check would then report a
 * discrepancy with no way to tell which side was wrong.
 */
function migrateExportPostingsPolymorphic(): void {
  const columns = db.prepare("PRAGMA table_info('export_postings')").all() as unknown as {
    name: string;
  }[];
  if (columns.length === 0) return;
  if (columns.some((c) => c.name === "receipt_id")) return;

  const before = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM export_postings").get() as { n: number | bigint }).n,
  );

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(exportPostingsTable("export_postings_migrated"));
    db.exec(`
      INSERT INTO export_postings_migrated
        (payment_id, receipt_id, line_id, absorbed_base_units)
      SELECT payment_id, NULL, line_id, absorbed_base_units
      FROM export_postings;
    `);
    db.exec("DROP TABLE export_postings");
    db.exec("ALTER TABLE export_postings_migrated RENAME TO export_postings");
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }

  // The indexes went with the dropped table. Recreate before anything can write.
  createExportPostingsIndexes();

  const after = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM export_postings").get() as { n: number | bigint }).n,
  );
  if (after !== before) {
    throw new Error(
      `Refusing to continue: export_postings had ${before} rows before migration and ${after} after`,
    );
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Refusing to continue: ${violations.length} foreign key violation(s) after migrating export_postings`,
    );
  }

  console.log(`[db] migrated export_postings to payment/receipt polymorphic (${after} row(s) kept)`);
}

// Order matters: posting_lines is rebuilt first (export_postings references it),
// and export_postings' rebuild needs `receipts` to already exist for its new
// foreign key. Both are no-ops on a database created fresh above.

/**
 * Brings a 6A-1 receipts table up to the gateway's shape.
 *
 * Two things force a rebuild rather than ALTERs: the status CHECK gains
 * `settle_unknown` (SQLite cannot ALTER a CHECK), and the replay defence needs
 * a UNIQUE across two new NOT NULL columns.
 *
 * THE TABLE IS EXPECTED TO BE EMPTY, and this refuses to guess if it is not.
 * 6A-1 shipped it with no write path at all, so any row here was written by
 * something this migration does not know about — and the new columns are NOT
 * NULL with no sensible default (there is no payer address to invent for a row
 * that predates the concept). Refusing loudly beats inventing a payer.
 */
function migrateReceiptsForGateway(): void {
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'receipts'")
    .get() as { sql: string } | undefined;
  if (!existing) return;

  const columns = (
    db.prepare("PRAGMA table_info('receipts')").all() as unknown as { name: string }[]
  ).map((c) => c.name);
  if (columns.includes("authorization_nonce")) return;

  const { n } = db.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number | bigint };
  if (Number(n) > 0) {
    throw new Error(
      `Refusing to migrate receipts: ${n} row(s) exist, but 6A-1 shipped this table with no ` +
        `write path. The new columns are NOT NULL and cannot be invented for an existing row.`,
    );
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("DROP TABLE receipts");
    db.exec(receiptsTable("receipts"));
    db.exec("COMMIT");
    console.log("[db] rebuilt receipts for the gateway (payer/nonce replay key, settle_unknown)");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Refusing to continue: ${violations.length} foreign key violation(s) after rebuilding receipts`,
    );
  }
}

migrateReceiptsForGateway();
migratePostingLineClasses();
migrateExportPostingsPolymorphic();
createExportPostingsIndexes();

/**
 * The QuickBooks Online integration.
 *
 * Five new tables, all created directly — nothing existing changes shape, so no
 * migration function, same reasoning as the rollup tables above.
 *
 * The shape is driven by three safety properties, each of which cost a table:
 *
 *   1. What an operator REVIEWED is what gets POSTED. A preview writes an
 *      immutable draft (payload + hash + the exact lines it covers); posting
 *      sends that stored payload rather than recomputing a rollup that may have
 *      moved underneath it.
 *   2. A posted entry is NEVER edited. Corrections are new documents linked
 *      back to the original, so the audit trail is a sequence of entries rather
 *      than a mutable record.
 *   3. Credentials are encrypted at rest — see src/lib/secrets.ts.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS qbo_connections (
    id                 TEXT PRIMARY KEY,
    company_id         TEXT NOT NULL REFERENCES companies(id),
    -- Intuit's id for the connected QuickBooks company.
    realm_id           TEXT NOT NULL,
    -- Both ENCRYPTED (src/lib/secrets.ts), never plaintext, and never returned
    -- by any route. Intuit rotates the refresh token roughly daily and
    -- force-expires its predecessor, so the new one must be persisted the
    -- moment it arrives and before the access token beside it is used for
    -- anything — a rotated token that was not saved is a dead connection that
    -- only a manual re-authorisation can revive.
    access_token_enc   TEXT NOT NULL,
    access_expires_at  TEXT NOT NULL,
    refresh_token_enc  TEXT NOT NULL,
    refresh_expires_at TEXT NOT NULL,
    connected_at       TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    -- One live connection per company. Reconnecting replaces the row rather
    -- than accumulating credentials nobody is tracking.
    UNIQUE (company_id)
  );
`);

/**
 * In-flight OAuth authorisations.
 *
 * Durable rather than in-memory on purpose. An in-memory map is the obvious
 * choice for a value that lives ninety seconds, but it loses every in-flight
 * authorisation on a restart — including one triggered by the operator editing
 * `.env` mid-setup, which is exactly when this flow runs. It also leaves no
 * record that an authorisation was ever attempted.
 *
 * Bound to the company it was issued for, so a state minted for one cannot
 * complete for another, and consumed exactly once by a guarded UPDATE — the
 * same single-use mechanism that burns an approval in reserveIfUnderCap.
 *
 * Also bound to the PERSON who started it, since 7A-3 item 4: `created_by`,
 * added at the end of this file (it is a foreign key into `users`, which is
 * created later). The callback lets only that person, signed in, finish the
 * connection. When this table was written there was one shared operator
 * credential and "who started this" was not a fact the system could know;
 * Stage 3 made it one, and a second company made it matter. See ADR 0017.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS qbo_oauth_states (
    state        TEXT PRIMARY KEY,
    company_id   TEXT NOT NULL REFERENCES companies(id),
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    -- Set when redeemed. NULL means unused; the guard is
    -- "WHERE state = ? AND consumed_at IS NULL", so a replay changes no rows.
    consumed_at  TEXT
  );
`);

/**
 * Per-company posting configuration.
 *
 * Deliberately NOT auto-populated. Fuel does not invent a chart of accounts for
 * a customer, and it does not create QuickBooks Classes per agent or Vendors
 * per merchant host — agent and merchant attribution live in Fuel, which is the
 * only place that has the full picture. See ADR 0008, which supersedes 0007 on
 * this point.
 */
/**
 * A FACTORY, NOT AN INLINE CREATE, and the difference is load-bearing.
 *
 * Every table this codebase rebuilds for a CHECK-constraint change --
 * posting_lines, receipts, export_postings -- defines its DDL this way so the
 * create and the rebuild are the same text and cannot drift. qbo_config was the
 * exception, and it was the one that could least afford to be: its inline
 * CREATE TABLE describes a FRESH database only. On any installation that has
 * been through migrateQboConfigAddCurrency and addColumnIfMissing, four columns
 * -- accounting_currency, currency_source, currency_checked_at,
 * revenue_account_id -- arrived afterwards by ALTER TABLE and appear nowhere in
 * that text.
 *
 * Copying it into a rebuild is the obvious move when there is no factory to
 * reuse, and it would either drop a live company's verified currency and income
 * account to NULL or mismatch the INSERT/SELECT column lists and fail boot for
 * every company. This extraction exists so the rebuild in the next commit has
 * one true shape to build against. It changes nothing on its own.
 */
/**
 * The realm a company is connected to right now, as a correlated subquery over
 * `table.company_id`. NULL when the company has no connection.
 *
 * Only ever used by a ONE-TIME backfill -- see recordQuickBooksRealms for why
 * it must never run twice.
 */
const CONNECTED_REALM_OF = (table: string) =>
  `(SELECT c.realm_id FROM qbo_connections c WHERE c.company_id = ${table}.company_id)`;

const qboConfigTable = (name: string) => `
  CREATE TABLE ${name} (
    company_id            TEXT PRIMARY KEY REFERENCES companies(id),
    -- QuickBooks account ids. Set explicitly by an operator, never guessed.
    expense_account_id    TEXT,
    suspense_account_id   TEXT,
    contra_account_id     TEXT,
    -- The income account revenue posts to. Null for every company connected
    -- before the earning side shipped; missingAccounts deliberately does NOT
    -- require it, so those companies keep posting spend rather than stalling.
    revenue_account_id    TEXT,
    -- What the contra account represents, which depends on how this customer
    -- funds Fuel: a prepaid balance they have already sent, a cash account, or
    -- a clearing account settled separately. It changes how the entry reads,
    -- not how it is computed.
    contra_account_kind   TEXT NOT NULL DEFAULT 'prepaid_asset'
                          CHECK (contra_account_kind IN ('prepaid_asset', 'cash', 'clearing')),
    -- 'daily' rolls every counterparty into one entry per day;
    -- 'counterparty_day' keeps ADR 0007's original per-vendor grain, renamed
    -- with the column it groups by. Daily is the default because it is the
    -- smaller footprint in someone else's books.
    rollup_grain          TEXT NOT NULL DEFAULT 'daily'
                          CHECK (rollup_grain IN ('daily', 'counterparty_day')),
    -- The currency this company's books are kept in, and HOW Fuel knows.
    -- Null means Fuel does not know, which blocks posting: this integration is
    -- USD-only and performs no conversion, so treating an unknown currency as
    -- USD would mis-state every figure at par. See ADR 0008.
    --
    -- The "currency_source" column exists so a response can never blur
    -- evidence with assertion. 'quickbooks_preferences' is the only value
    -- that means Fuel
    -- read it from Intuit; anything weaker must announce itself as weaker.
    accounting_currency   TEXT
                          CHECK (accounting_currency IS NULL OR length(accounting_currency) = 3),
    currency_source       TEXT
                          CHECK (currency_source IS NULL OR
                                 currency_source IN ('quickbooks_preferences')),
    currency_checked_at   TEXT,
    updated_at            TEXT NOT NULL,
    -- WHICH QUICKBOOKS COMPANY THE ACCOUNT IDS ABOVE WERE READ FROM (7A-3).
    -- QuickBooks account ids are small per-company integers that recur across
    -- companies, so an id is meaningless without the books it names an account
    -- in: sent to different books it often resolves to a DIFFERENT, real
    -- account, and the entry is accepted with no error anywhere. NULL means
    -- Fuel does not know, which is treated exactly like a mismatch.
    --
    -- Last in the table, and last in qbo_posting_drafts and qbo_postings too, so
    -- a fresh database and one that gained the column by ALTER TABLE (which
    -- appends) hold their columns in the same order.
    accounts_realm_id     TEXT
  )
`;

db.exec(qboConfigTable("IF NOT EXISTS qbo_config"));

/**
 * Adds the accounting-currency columns to an existing qbo_config table.
 *
 * All three are nullable with no default, the one shape SQLite's ADD COLUMN
 * handles in place. Null is deliberately the migrated value: an existing
 * company has never had its currency read from Intuit, and inventing 'USD' for
 * it would manufacture exactly the false confidence this column exists to
 * prevent. Those companies re-verify by running account setup again.
 *
 * Each column added independently, so a process killed between ALTERs finishes
 * on the next boot — same reasoning as migrateAgentsAddFreezeColumns.
 */
function migrateQboConfigAddCurrency(): void {
  const columns = db.prepare("PRAGMA table_info('qbo_config')").all() as unknown as {
    name: string;
  }[];
  if (columns.length === 0) return;

  const added: string[] = [];
  // CHECK constraints cannot be attached by ADD COLUMN, so the added columns
  // carry none. The constraints above apply to freshly created databases; the
  // authority for both old and new is the write path in src/db/qbo.ts, which
  // is the only thing that sets these.
  if (!columns.some((c) => c.name === "accounting_currency")) {
    db.exec("ALTER TABLE qbo_config ADD COLUMN accounting_currency TEXT");
    added.push("accounting_currency");
  }
  if (!columns.some((c) => c.name === "currency_source")) {
    db.exec("ALTER TABLE qbo_config ADD COLUMN currency_source TEXT");
    added.push("currency_source");
  }
  if (!columns.some((c) => c.name === "currency_checked_at")) {
    db.exec("ALTER TABLE qbo_config ADD COLUMN currency_checked_at TEXT");
    added.push("currency_checked_at");
  }
  if (added.length > 0) {
    console.log(
      `[db] added qbo_config column(s): ${added.join(", ")} ` +
        `(currency unknown until account setup re-runs)`,
    );
  }
}

migrateQboConfigAddCurrency();
addColumnIfMissing(
  "qbo_config",
  "revenue_account_id",
  "revenue_account_id TEXT",
  "null until account setup re-runs; spend keeps posting meanwhile, revenue waits",
);

/**
 * A previewed entry, frozen.
 *
 * THE POINT OF THIS TABLE: an operator reviews a payload and then clicks post.
 * Between those two moments the rollup can change — a posting run can add
 * lines, or a settling payment can turn a suspense balance into a
 * reclassification. Recomputing at post time would mean the entry reviewed and
 * the entry posted are different documents, which makes the review meaningless.
 *
 * So a preview freezes: the exact payload, a hash of it, and (in
 * qbo_draft_lines) the exact posting lines it covers. Posting sends the stored
 * payload. If new lines have appeared inside the draft's scope, the draft is
 * stale and posting refuses rather than quietly posting something else.
 */
const qboPostingDraftsTable = (name: string) => `
  CREATE TABLE ${name} (
    id            TEXT PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES companies(id),
    -- What this draft covers, so staleness can be evaluated against the same
    -- scope that produced it.
    grain         TEXT NOT NULL CHECK (grain IN ('daily', 'counterparty_day')),
    posting_day   TEXT NOT NULL,
    -- WHICH DIRECTION THIS DOCUMENT IS. Spend and revenue post as separate
    -- JournalEntries rather than one combined document, because 0008 makes a
    -- posted entry permanent and correctable only by a whole new linked entry:
    -- a combined document with a revenue-mapping error would force re-booking
    -- correctly-posted spend just to fix the revenue half.
    --
    -- DEFAULT 'spend' is the honest migrated value, not a convenience. Every
    -- draft that existed before this column did was a spend draft, because no
    -- revenue line could exist.
    direction     TEXT NOT NULL DEFAULT 'spend' CHECK (direction IN ('spend', 'earn')),
    -- NULL for a 'daily' draft, which spans every counterparty. Renamed from
    -- vendor_host with the grain: the other party is a vendor only on the spend
    -- side, and a column called vendor_host holding a customer's endpoint label
    -- is the same false statement 0012 objects to in the CSV header.
    counterparty  TEXT,
    doc_number    TEXT NOT NULL,
    -- The exact JournalEntry JSON, and a SHA-256 over it. The hash is checked
    -- before posting so a payload altered in the database is detected rather
    -- than sent.
    payload_json  TEXT NOT NULL,
    payload_hash  TEXT NOT NULL,
    -- A hash over everything this draft was derived FROM: the line ids it
    -- covers and, for each, the payments beneath it with their statuses.
    --
    -- Recording the payload hash alone is not enough. Posting lines are
    -- append-only, so a new line appearing under the same scope is one way the
    -- rollup moves — but a payment settling out of "unreconciled" is another,
    -- and it changes what the numbers MEAN without touching any existing row.
    -- Comparing this fingerprint at post time catches both, so "the world moved
    -- under this preview" is a single check rather than a list of cases someone
    -- has to remember to extend.
    source_fingerprint TEXT NOT NULL,
    -- previewed: awaiting a decision. posted: a qbo_postings row references it.
    -- superseded: the rollup moved; a new preview is required. discarded: an
    -- operator threw it away.
    status        TEXT NOT NULL CHECK (status IN ('previewed', 'posted', 'superseded', 'discarded')),
    created_at    TEXT NOT NULL,
    -- The QuickBooks company this payload was built for (7A-3). The payload
    -- carries that company's account ids, so it can only ever be sent there.
    realm_id      TEXT
  )
`;

db.exec(qboPostingDraftsTable("IF NOT EXISTS qbo_posting_drafts"));

/**
 * Rebuilds qbo_posting_drafts for the direction column, the grain rename and
 * the counterparty rename.
 *
 * ONE REBUILD FOR ALL THREE, because they are one change: a draft's direction,
 * the grain it was taken at, and what that grain groups by are the same fact
 * described three ways. Splitting them would mean rebuilding the same table
 * three times for no additional safety.
 *
 * SEPARATE FROM THE qbo_config REBUILD BELOW, though, and that separation is
 * deliberate. Two independent migrations mean a partial failure is a state each
 * guard can read on the next boot -- drafts migrated, config not -- and the
 * second finishes on its own. One transaction spanning both tables would trade
 * that for a single all-or-nothing rollback, which sounds safer and is not: the
 * rollback can itself fail, and no shape guard can describe "half done".
 *
 * qbo_postings.draft_id references this table and ids are copied verbatim, so a
 * live `pending` posting survives intact -- reconcilePending works off the
 * frozen payload_json and doc_number, neither of which this touches.
 */
function migrateQboPostingDraftsForDirection(): void {
  const columns = (
    db.prepare("PRAGMA table_info('qbo_posting_drafts')").all() as unknown as { name: string }[]
  ).map((c) => c.name);
  if (columns.length === 0) return;
  // The shape guard: already migrated if both the new column and the new name
  // are present. Checked on the columns rather than on the DDL text, because a
  // CHECK clause is the thing this changes and matching on it is what
  // migratePaymentStatuses had to do only because it had no new column to look
  // for. This one does.
  if (columns.includes("direction") && columns.includes("counterparty")) return;

  const before = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM qbo_posting_drafts").get() as { n: number | bigint }).n,
  );
  const oldCounterparty = columns.includes("counterparty") ? "counterparty" : "vendor_host";

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(qboPostingDraftsTable("qbo_posting_drafts_migrated"));
    // EVERY COLUMN NAMED, never SELECT *. verify-migration proves the declared
    // and migrated shapes of these tables hold their columns in DIFFERENT
    // ORDERS, because ALTER TABLE appends -- so a positional copy would write
    // one column's values into another, silently, wherever the types agree.
    //
    // 'spend' for every existing row: no revenue line could exist before this
    // migration, so every draft that predates it is a spend draft. That is a
    // fact about the data, not a default chosen for convenience.
    //
    // realm_id takes the company's connected realm, by the same one-time rule
    // recordQuickBooksRealms applies and for the reason written there. This
    // rebuild is a one-time step too, and a table it produces already has the
    // column, so leaving it NULL here would leave it NULL for good.
    db.exec(`
      INSERT INTO qbo_posting_drafts_migrated
        (id, company_id, grain, posting_day, direction, counterparty, doc_number,
         payload_json, payload_hash, source_fingerprint, status, created_at, realm_id)
      SELECT id, company_id,
             CASE grain WHEN 'vendor_day' THEN 'counterparty_day' ELSE grain END,
             posting_day, 'spend', ${oldCounterparty}, doc_number,
             payload_json, payload_hash, source_fingerprint, status, created_at,
             ${CONNECTED_REALM_OF("qbo_posting_drafts")}
      FROM qbo_posting_drafts;
    `);
    db.exec("DROP TABLE qbo_posting_drafts");
    db.exec("ALTER TABLE qbo_posting_drafts_migrated RENAME TO qbo_posting_drafts");
    db.exec("COMMIT");
    console.log(
      `[db] migrated qbo_posting_drafts: direction column added, vendor_day -> ` +
        `counterparty_day, ${oldCounterparty} -> counterparty (${before} draft(s) kept)`,
    );
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }

  const after = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM qbo_posting_drafts").get() as { n: number | bigint }).n,
  );
  if (after !== before) {
    throw new Error(
      `Refusing to continue: qbo_posting_drafts had ${before} rows before migration and ${after} after`,
    );
  }
  // qbo_draft_lines.draft_id and qbo_postings.draft_id both point here. A
  // dangling one would strand a posted document from the lines it covers, which
  // is the trail an operator reconciles against.
  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Refusing to continue: ${violations.length} foreign key violation(s) after migrating qbo_posting_drafts`,
    );
  }
}

/**
 * Rebuilds qbo_config so its rollup_grain CHECK admits 'counterparty_day'.
 *
 * A CHECK constraint cannot be altered in place, and this one would refuse the
 * new value outright -- so an operator on an existing database could not select
 * the grain at all, with SQLite's error rather than a useful one.
 *
 * THE COLUMN LIST IS EXPLICIT AND MUST STAY THAT WAY. qbo_config is the table
 * whose declared shape and migrated shape hold the same columns in different
 * orders (accounting_currency, currency_source, currency_checked_at and
 * revenue_account_id all arrived by ALTER TABLE, which appends). SELECT * here
 * would write a company's revenue_account_id into contra_account_kind on
 * exactly the databases that have live data, and both are TEXT so nothing would
 * complain. verify-migration pins that ordering difference for this reason.
 */
function migrateQboConfigGrain(): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'qbo_config'")
    .get() as { sql: string } | undefined;
  if (!row) return;
  // Matched on the CHECK clause specifically rather than on the whole DDL: the
  // comments in this table name grain values too, so a looser match would call
  // an unmigrated table migrated. The lesson migratePaymentStatuses recorded.
  if (/rollup_grain\s+IN\s*\(\s*'daily',\s*'counterparty_day'\s*\)/.test(row.sql)) return;

  const before = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM qbo_config").get() as { n: number | bigint }).n,
  );

  /*
   * PRE-FLIGHT, BECAUSE A REBUILD APPLIES CONSTRAINTS THAT WERE NEVER ENFORCED.
   *
   * `accounting_currency`, `currency_source` and `currency_checked_at` arrived
   * by ALTER TABLE, which cannot carry a CHECK -- migrateQboConfigAddCurrency
   * says so itself: "the added columns carry none... the authority for both old
   * and new is the write path". So on every existing database those columns
   * have been unconstrained since the day they appeared, while the DDL has
   * claimed otherwise.
   *
   * Copying into a table built from that DDL enforces them for the first time,
   * retroactively, against data written when nothing was checking. A single
   * offending row would abort the INSERT and the message an operator would see
   * is "CHECK constraint failed: currency_source IS NULL OR ..." with no row,
   * no column and no value -- at boot, on their database.
   *
   * So look first and say exactly what is wrong. NOT normalised away: a
   * currency Fuel recorded from a weaker source is a fact about what happened,
   * and quietly nulling it to make a migration pass would destroy the evidence
   * this integration is built to keep honest (0008). An operator re-runs
   * account setup; Fuel does not invent the answer.
   */
  const offending = db
    .prepare(
      `SELECT company_id, accounting_currency, currency_source, contra_account_kind, rollup_grain
         FROM qbo_config
        WHERE (accounting_currency IS NOT NULL AND length(accounting_currency) <> 3)
           OR (currency_source IS NOT NULL AND currency_source <> 'quickbooks_preferences')
           OR contra_account_kind NOT IN ('prepaid_asset', 'cash', 'clearing')
           OR rollup_grain NOT IN ('daily', 'vendor_day', 'counterparty_day')`,
    )
    .all() as unknown as Record<string, unknown>[];
  if (offending.length > 0) {
    throw new Error(
      `Refusing to migrate qbo_config: ${offending.length} row(s) hold values the table's own ` +
        `CHECK constraints forbid, written while ALTER TABLE left those columns unconstrained. ` +
        `Fix or clear them and re-run account setup; Fuel will not guess. Rows: ` +
        JSON.stringify(offending),
    );
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(qboConfigTable("qbo_config_migrated"));
    // accounts_realm_id: the one-time backfill, as in the drafts rebuild.
    db.exec(`
      INSERT INTO qbo_config_migrated
        (company_id, expense_account_id, suspense_account_id, contra_account_id,
         revenue_account_id, contra_account_kind, rollup_grain,
         accounting_currency, currency_source, currency_checked_at, updated_at,
         accounts_realm_id)
      SELECT company_id, expense_account_id, suspense_account_id, contra_account_id,
             revenue_account_id, contra_account_kind,
             CASE rollup_grain WHEN 'vendor_day' THEN 'counterparty_day' ELSE rollup_grain END,
             accounting_currency, currency_source, currency_checked_at, updated_at,
             ${CONNECTED_REALM_OF("qbo_config")}
      FROM qbo_config;
    `);
    db.exec("DROP TABLE qbo_config");
    db.exec("ALTER TABLE qbo_config_migrated RENAME TO qbo_config");
    db.exec("COMMIT");
    console.log(
      `[db] migrated qbo_config: rollup_grain now daily/counterparty_day (${before} config(s) kept)`,
    );
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }

  const after = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM qbo_config").get() as { n: number | bigint }).n,
  );
  if (after !== before) {
    throw new Error(
      `Refusing to continue: qbo_config had ${before} rows before migration and ${after} after`,
    );
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Refusing to continue: ${violations.length} foreign key violation(s) after migrating qbo_config`,
    );
  }
}

// Two migrations, run one after the other and never sharing a transaction. See
// the note on migrateQboPostingDraftsForDirection for why that separation is
// the safe arrangement rather than the careless one.
migrateQboConfigGrain();
migrateQboPostingDraftsForDirection();

/**
 * Which posting lines a draft froze.
 *
 * Two jobs. It is how staleness is detected: posting_lines are append-only and
 * never updated, so if a line now falls inside a draft's scope but is not in
 * this set, the rollup has moved. And it is the middle of the drill-down chain
 * — a posted QuickBooks entry resolves through here to posting_lines, then
 * export_postings, then payments, then the approval that authorised each one.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS qbo_draft_lines (
    draft_id TEXT NOT NULL REFERENCES qbo_posting_drafts(id),
    line_id  TEXT NOT NULL REFERENCES posting_lines(id),
    PRIMARY KEY (draft_id, line_id)
  );
`);

/**
 * A document that has been, or may have been, created in QuickBooks.
 *
 * `pending` is fail-closed in exactly the sense `unreconciled` is for payments:
 * it means a document MAY exist, and it is never blind-retried. A retry reuses
 * the stored `request_id` so Intuit replays its original response rather than
 * creating a second entry; if that window has passed, recovery queries
 * QuickBooks for `doc_number`, which is deterministic for precisely this
 * purpose.
 *
 * `corrects_posting_id` carries the never-edit rule: a posted entry is never
 * updated or replaced, so a correction is a new row pointing at the one it
 * corrects, with its own distinct document number.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS qbo_postings (
    id                  TEXT PRIMARY KEY,
    company_id          TEXT NOT NULL REFERENCES companies(id),
    draft_id            TEXT NOT NULL REFERENCES qbo_posting_drafts(id),
    doc_number          TEXT NOT NULL,
    -- Sent as Intuit's ?requestid= query parameter, written BEFORE the request
    -- goes out and reused verbatim on any retry.
    request_id          TEXT NOT NULL,
    -- Intuit's ids, NULL until a response is confirmed.
    qbo_entity_id       TEXT,
    qbo_sync_token      TEXT,
    -- The payload actually sent, kept for audit. Not derived from the draft at
    -- read time: what was sent is a historical fact and must stay readable even
    -- if the draft is later superseded.
    posted_payload_json TEXT,
    posted_payload_hash TEXT,
    status              TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'failed')),
    detail              TEXT,
    corrects_posting_id TEXT REFERENCES qbo_postings(id),
    created_at          TEXT NOT NULL,
    posted_at           TEXT,
    -- The QuickBooks company this document was sent to (7A-3). A token only
    -- reaches the company it was granted for, so this is also the only place
    -- the document can be looked up, reconciled or reversed.
    realm_id            TEXT
  );
`);

recordQuickBooksRealms();

/**
 * Adds the realm columns (7A-3) to a database that predates them, and fills
 * them in -- ONCE.
 *
 * WHAT THE BACKFILL CLAIMS. Every existing posting, draft and account mapping
 * was made against the QuickBooks company its Fuel company is connected to
 * now. True of every database this has run on: one sandbox company has ever
 * existed on this developer account (docs/roadmap.md, 7A-1 gap (b)). That is
 * an argument, not a proof, and the live step of 7A-3 proves it by finding
 * each posted document in the connected books.
 *
 * WHY EXACTLY ONCE, and why this is not a "fill in any NULL" sweep. The claim
 * above is only true AT THE MOMENT THE COLUMN ARRIVES. A company with no
 * connection today keeps NULL -- its artifacts were made against books Fuel
 * can no longer name. If a later boot filled that NULL from whatever the
 * company had connected to since, it would stamp old documents with NEW
 * books: the exact false statement this column exists to prevent, made by
 * the migration itself. So the fill happens only in the step that creates the
 * column, and a column that already exists is never touched again.
 *
 * ALTER AND UPDATE IN ONE TRANSACTION, for the same reason. A process killed
 * between them would leave the column present and empty, and the next boot --
 * seeing the column -- would skip the fill forever. SQLite's ALTER TABLE is
 * transactional, so a rollback takes the column away with it and the next
 * boot starts clean.
 *
 * NULL IS READ AS A MISMATCH, never as "the current realm". A legacy row that
 * could not be attributed is refused rather than trusted.
 */
function recordQuickBooksRealms(): void {
  const targets: { table: string; column: string }[] = [
    { table: "qbo_postings", column: "realm_id" },
    { table: "qbo_posting_drafts", column: "realm_id" },
    { table: "qbo_config", column: "accounts_realm_id" },
  ];

  for (const { table, column } of targets) {
    const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as unknown as { name: string }[];
    if (columns.some((c) => c.name === column)) continue;

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      const { changes } = db
        .prepare(`UPDATE ${table} SET ${column} = ${CONNECTED_REALM_OF(table)}`)
        .run();
      const unattributed = Number(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IS NULL`).get() as {
            n: number | bigint;
          }
        ).n,
      );
      db.exec("COMMIT");
      console.log(
        `[db] added ${table}.${column}: ${Number(changes) - unattributed} row(s) attributed to ` +
          `their company's connected QuickBooks company, ${unattributed} left unattributed (no connection)`,
      );
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back; the original error is what matters.
      }
      throw error;
    }
  }
}

// Created after any migration, since dropping the old table drops its indexes.
db.exec("CREATE INDEX IF NOT EXISTS payments_agent_idx ON payments(agent_id, status)");
// Indexed on the expression the accounting export actually filters and sorts
// by, not on created_at alone — SQLite cannot use a plain created_at index to
// satisfy a COALESCE(settled_at, created_at) range predicate, so that index
// would look reassuring and do nothing.
db.exec(
  "CREATE INDEX IF NOT EXISTS payments_ledger_date_idx ON payments(COALESCE(settled_at, created_at))",
);
db.exec("CREATE INDEX IF NOT EXISTS agents_team_idx ON agents(team_id)");
db.exec("CREATE INDEX IF NOT EXISTS teams_company_idx ON teams(company_id)");
db.exec(
  "CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests(status, created_at)",
);
// The rollup reads lines by date range (the postings list and CSV) and groups
// them by counterparty and day, which is the same order this index provides.
//
// The index is dropped along with the table when migratePostingLineClasses
// rebuilds it, which is why this runs after the migrations rather than beside
// the CREATE.
db.exec(
  "CREATE INDEX IF NOT EXISTS posting_lines_day_idx ON posting_lines(posting_day, counterparty)",
);
// The pre-rename index, if it survived from an older database. Dropped rather
// than left: it indexes a column that no longer exists under a name that now
// misleads, and SQLite keeps it around perfectly happily.
db.exec("DROP INDEX IF EXISTS posting_lines_vendor_idx");
db.exec("CREATE INDEX IF NOT EXISTS posting_lines_agent_idx ON posting_lines(agent_id)");
// Drill-down walks line -> payments; the residual computation walks the other
// way, payment -> everything already absorbed from it. Both directions are hot,
// and the primary key only serves the second.
db.exec("CREATE INDEX IF NOT EXISTS export_postings_line_idx ON export_postings(line_id)");
// Staleness checks look up drafts by exactly the scope they cover.
db.exec(
  "CREATE INDEX IF NOT EXISTS qbo_drafts_scope_idx ON qbo_posting_drafts(company_id, status, posting_day)",
);
// Reconciling an unconfirmed posting starts from its deterministic doc number.
db.exec("CREATE INDEX IF NOT EXISTS qbo_postings_doc_idx ON qbo_postings(company_id, doc_number)");
db.exec("CREATE INDEX IF NOT EXISTS qbo_postings_draft_idx ON qbo_postings(draft_id)");
enforceOneLiveAttemptPerDocNumber();
enforceOneCompanyPerRealm();
// The reaper-equivalent sweep for expired, unconsumed OAuth states.
db.exec("CREATE INDEX IF NOT EXISTS qbo_oauth_states_expiry_idx ON qbo_oauth_states(expires_at)");

/**
 * One pending-or-posted attempt per document number, per company.
 *
 * PARTIAL, NOT TOTAL. A `failed` attempt proved it created nothing, and the
 * draft it belonged to is posted afresh under the same number -- that retry is
 * the designed path, so failed rows must not count. Only the two states in
 * which a document does or may exist are held to one per number: two of those
 * sharing a number is how one attempt adopts the other's document through
 * Intuit's duplicate-number fault.
 *
 * Report and refuse, never normalise: an existing clash means two attempts
 * each believe they own one document, and which one is right is a question for
 * QuickBooks and an operator, not for a boot sequence.
 */
function enforceOneLiveAttemptPerDocNumber(): void {
  const clashes = db
    .prepare(
      `SELECT company_id, doc_number, GROUP_CONCAT(id, ', ') AS ids
         FROM qbo_postings WHERE status IN ('pending', 'posted')
        GROUP BY company_id, doc_number HAVING COUNT(*) > 1`,
    )
    .all() as unknown as { company_id: string; doc_number: string; ids: string }[];
  if (clashes.length > 0) {
    throw new Error(
      "Refusing to continue: more than one pending or posted QuickBooks attempt shares a " +
        `document number (${clashes.map((c) => `company ${c.company_id} ${c.doc_number}: ${c.ids}`).join("; ")}). ` +
        "Nothing was changed. Reconcile each against QuickBooks and mark the one that did not create the document failed.",
    );
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS qbo_postings_live_doc_uniq
       ON qbo_postings(company_id, doc_number) WHERE status IN ('pending', 'posted')`,
  );
}

/**
 * One Fuel company per QuickBooks company. See RealmAlreadyConnectedError in
 * db/qbo.ts for why. Same report-and-refuse rule: which company keeps a
 * shared set of books is not a boot sequence's decision.
 */
function enforceOneCompanyPerRealm(): void {
  const shared = db
    .prepare(
      `SELECT realm_id, GROUP_CONCAT(company_id, ', ') AS companies
         FROM qbo_connections GROUP BY realm_id HAVING COUNT(*) > 1`,
    )
    .all() as unknown as { realm_id: string; companies: string }[];
  if (shared.length > 0) {
    throw new Error(
      "Refusing to continue: a QuickBooks company is connected to more than one Fuel company " +
        `(${shared.map((r) => `realm ${r.realm_id}: ${r.companies}`).join("; ")}). ` +
        "Nothing was changed. Disconnect all but one, then boot again.",
    );
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS qbo_connections_realm_uniq ON qbo_connections(realm_id)");
}

/**
 * WHO IS CALLING, AS A PERSON — the table Stage 3 exists to add.
 *
 * Everything before this identified a ROLE. `src/lib/auth.ts` resolves operator
 * or agent from which of two shared secrets was presented, which means every
 * operator is the same indistinguishable operator: nothing can be revoked for
 * one person without changing it for everyone, and an approval records that a
 * human decided, never which one. A user row is what makes those questions
 * answerable.
 *
 * `email` IS UNIQUE WITHIN A COMPANY, NOT ACROSS THE PLATFORM (ADR 0018). It
 * was global until the invite oracle was closed. The reasoning then: a sign-in
 * form that asks only for an email and a password needs one address to mean
 * one account. It was sound about sign-in and wrong about invites. Fuel sends
 * no email, so whoever mints an invite holds its token and can redeem it. With
 * one account per address platform-wide, redeeming answered "taken" for an
 * address with an account at ANY company and succeeded otherwise, so any owner
 * could learn who had an account elsewhere, and could claim an address so its
 * real owner could never join their own company. No response wording hides
 * that; only taking the other company's account out of the way does.
 *
 * So sign-in now names the company, by a handle the person types
 * (src/lib/handles.ts). The old objection was that the form "would have to ask
 * which company, which an attacker would enjoy being asked". It is answered by
 * Fuel never ANSWERING that question: it never lists an address's companies,
 * and an unknown handle, an unknown address and a wrong password are one
 * refusal at one cost.
 *
 * Two accounts with one address are two people as far as Fuel is concerned.
 * Stored lowercased and trimmed (see `normaliseEmail` in src/db/users.ts), so
 * the uniqueness is on the same form the login lookup uses; SQLite's default
 * collation is case-SENSITIVE, so without that normalisation `A@x.com` and
 * `a@x.com` would be two accounts.
 *
 * `role` is the USER's role within its company, and is deliberately not the
 * same thing as the `Role` that guards routes. An owner may invite people and
 * manage users; both owner and operator act with operator authority over money.
 * Keeping them separate means adding a money role later does not require
 * re-deciding who may invite.
 *
 * `disabled_at` rather than DELETE: a user who approved a payment is referenced
 * by that decision forever, and deleting the row would either break the
 * reference or erase who decided. Disabling ends access and keeps the history.
 */
function usersTable(name: string): string {
  return `
  CREATE TABLE IF NOT EXISTS ${name} (
    id            TEXT PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES companies(id),
    -- Lowercased and trimmed before it ever reaches this column. Unique within
    -- the company, not across the platform: see the comment above.
    email         TEXT NOT NULL,
    -- scrypt, versioned and self-describing: v1.<N>.<r>.<p>.<salt>.<hash>.
    -- See src/lib/passwords.ts. Never leaves the database.
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('owner', 'operator')),
    created_at    TEXT NOT NULL,
    -- Set to end access without erasing who decided what. NULL means active.
    disabled_at   TEXT,
    UNIQUE (company_id, email)
  );
`;
}
db.exec(usersTable("users"));
db.exec("CREATE INDEX IF NOT EXISTS users_company_idx ON users(company_id)");

/**
 * A signed-in session.
 *
 * `id` IS THE SHA-256 OF THE COOKIE VALUE, AND THE COOKIE VALUE IS NEVER
 * STORED. The same argument src/lib/secrets.ts makes about `fuel.db` being
 * copied to a laptop, attached to a bug report or snapshotted into a backup —
 * the `fuel.db.bak-*` files in this repo root are exactly that habit. If the
 * cookie were stored, a copied database would be a set of live logins that an
 * attacker could replay without knowing anybody's password. A hash cannot be
 * replayed: the browser holds the only usable copy.
 *
 * TWO DEADLINES, DOING DIFFERENT JOBS. `expires_at` is absolute, so a session
 * dies on a schedule no amount of activity extends — that bounds how long a
 * stolen cookie is worth anything. `last_seen_at` drives an idle timeout, which
 * is what closes an unattended browser on a shared machine. Neither is a
 * substitute for the other.
 *
 * `revoked_at` is what sign-out and "disable this user" actually write, so the
 * end of a session is a recorded event rather than a deleted row.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    -- SHA-256 of the cookie value, hex. NOT the cookie value.
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL,
    -- Absolute deadline: activity does not extend it.
    expires_at   TEXT NOT NULL,
    -- Bumped on use, at most once a minute, to drive the idle timeout.
    last_seen_at TEXT NOT NULL,
    -- Set by sign-out or by disabling the user. NULL means live.
    revoked_at   TEXT
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)");

/**
 * The only way an account comes into existence.
 *
 * THERE IS NO OPEN SIGNUP, and this table is why. A person can create an
 * account only by redeeming an invite somebody deliberately minted, which keeps
 * "a second real company now exists" an act rather than an accident during a
 * private beta.
 *
 * `token_hash` IS A SHA-256, AND THE TOKEN IS NEVER STORED — the same argument
 * as `sessions.id`. An invite token is a credential: whoever holds it can
 * create an account. If the table held the token itself, a copied `fuel.db`
 * would be a pile of usable invites rather than a pile of useless hashes. It
 * also means the token is shown exactly once, when it is minted, and cannot be
 * recovered afterwards — lose it and you mint another.
 *
 * `company_id IS NULL` MEANS "THIS INVITE CREATES A COMPANY". That is the
 * dangerous kind, so only `scripts/mint-invite.ts` can produce it and only
 * behind an explicit flag; the in-product route always writes the inviter's own
 * company id and has no way to express NULL. A NULL here must pair with the
 * `owner` role, because the first person in a company has nobody above them to
 * grant it — enforced by a CHECK rather than by whoever writes the row.
 *
 * `email` binds the invite to one recipient. An invite that anyone could redeem
 * is a bearer token for an account in someone else's company, and forwarding
 * one — by accident or otherwise — would be enough.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS invites (
    id          TEXT PRIMARY KEY,
    -- SHA-256 of the token, hex. NOT the token.
    token_hash  TEXT NOT NULL UNIQUE,
    -- NULL means this invite creates a NEW company. Only a script mints those.
    company_id  TEXT REFERENCES companies(id),
    -- Lowercased and trimmed, compared against the same form at signup.
    email       TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'operator')),
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    -- Set when redeemed; the guard is "WHERE id = ? AND redeemed_at IS NULL",
    -- so a second redemption changes no rows. Same shape as qbo_oauth_states.
    redeemed_at TEXT,
    redeemed_by TEXT REFERENCES users(id),
    -- Set when withdrawn before use. Distinct from redeemed: nobody used it.
    revoked_at  TEXT,
    -- The first member of a new company cannot be invited as a plain operator:
    -- there would be no owner to administer it, and no way to make one.
    CHECK (company_id IS NOT NULL OR role = 'owner')
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS invites_company_idx ON invites(company_id)");

/**
 * WHO DECIDED IT.
 *
 * Added last, deliberately: it is a foreign key into `users`, so it cannot be
 * declared until that table exists, and `users` is created a few statements
 * above. Adding it inside the original `CREATE TABLE approval_requests` would
 * have meant reordering the whole file around a column.
 *
 * NULLABLE, AND THE NULLS ARE HONEST. Every approval decided before Stage 3 was
 * decided by a holder of the shared operator key, which names no person. There
 * is no answer to backfill. Writing the bootstrap owner's id into those rows
 * would be inventing an audit trail, which is worse than admitting one does not
 * exist — an auditor who trusts a fabricated name is worse off than one who
 * sees a blank and asks.
 *
 * A NULL therefore means exactly one thing from here on: "a shared key decided
 * this, and no individual can be named". That is the reading `decideRequest`
 * relies on when it refuses a key for a company that has real accounts.
 *
 * `addColumnIfMissing` rather than a table rebuild, for the reason recorded
 * above it: ALTER TABLE ADD COLUMN preserves every existing row and index, and
 * a rebuild of a table this central is risk taken for no gain.
 */
addColumnIfMissing(
  "approval_requests",
  "decided_by",
  "decided_by TEXT REFERENCES users(id)",
  "which person decided this approval; NULL for every decision a shared key made",
);

/**
 * A PENDING POSTING WRITTEN OFF BY AN OWNER, because the QuickBooks books it
 * was sent to cannot be asked about it any more (7A-3 item 3, ADR 0016).
 *
 * A FLAG, NOT A STATUS. The posting stays `pending`, because that is still the
 * true statement: the document may exist in books Fuel can no longer reach.
 * Everything that reads `pending` as "its lines are held, its number is taken"
 * therefore keeps doing so untouched -- the spend is never re-posted
 * automatically, which is the decision recorded in 0016. Only the two readers
 * that mean "still waiting on an answer" skip a written-off posting: the guard
 * on changing books, and the needs-reconciliation list.
 *
 * Added here, after `users`, for the reason `decided_by` is: `abandoned_by`
 * is a foreign key into that table.
 *
 * NO BACKFILL. Nothing has ever been written off, so NULL is simply true.
 * ADD COLUMN cannot attach a CHECK (see migrateQboConfigAddCurrency), so "an
 * abandoned posting always names who did it" is enforced by the only writer,
 * markPostingAbandoned in src/db/qbo-postings.ts, and tested there.
 */
addColumnIfMissing("qbo_postings", "abandoned_at", "abandoned_at TEXT", "when an owner wrote it off; NULL for every posting until then");
addColumnIfMissing(
  "qbo_postings",
  "abandoned_by",
  "abandoned_by TEXT REFERENCES users(id)",
  "which owner wrote it off",
);
addColumnIfMissing("qbo_postings", "abandon_reason", "abandon_reason TEXT", "the owner's reason, in their words");
addColumnIfMissing(
  "qbo_postings",
  "abandon_evidence",
  "abandon_evidence TEXT",
  "why Fuel could not ask QuickBooks at the moment it was written off",
);

/**
 * WHO STARTED A QUICKBOOKS CONNECTION (7A-3 item 4, ADR 0017).
 *
 * A connect link was bound to a company and to nobody in it, so anyone who
 * opened it could finish it: an operator at one company could hand the Intuit
 * link to someone at another, and the books THAT person consented for were
 * saved under the first company. The callback now requires the person who
 * started the link to be the one who brings it back, and this is where it
 * learns who that was.
 *
 * Added here, after `users`, for the reason `decided_by` is: it is a foreign
 * key into that table.
 *
 * NO BACKFILL. A state lives ten minutes, and one minted before this column
 * existed names nobody -- which the callback refuses rather than reading as
 * "anybody". ADD COLUMN cannot attach a CHECK, so "every state names its
 * starter" is enforced by the only writer, createOAuthState in src/db/qbo.ts.
 */
addColumnIfMissing(
  "qbo_oauth_states",
  "created_by",
  "created_by TEXT REFERENCES users(id)",
  "which signed-in person started this connection; only they can finish it",
);

/**
 * COMPANY HANDLES (ADR 0018): how a person names their company at sign-in.
 *
 * Nullable, because SQLite cannot add a NOT NULL column with a per-row value to
 * a populated table, and because some writers (the default-company seed above,
 * test fixtures) insert companies without one. Every company is given one
 * below at each boot, and `createCompany` writes one itself. A company with no
 * handle cannot be signed into, which fails closed.
 *
 * The fill runs at EVERY boot, unlike the realm backfills, because there is no
 * wrong answer to find: a fresh random handle for a company that has none is
 * correct whenever it happens. A handle, once set, is never changed here.
 */
addColumnIfMissing(
  "companies",
  "handle",
  "handle TEXT",
  "how a person names their company at sign-in; filled for every company below",
);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS companies_handle_uniq ON companies(handle)");
{
  const unnamed = db.prepare("SELECT id, name FROM companies WHERE handle IS NULL").all() as {
    id: string;
    name: string;
  }[];
  const give = db.prepare("UPDATE companies SET handle = ? WHERE id = ? AND handle IS NULL");
  for (const company of unnamed) {
    for (let attempt = 1; ; attempt++) {
      try {
        // A 0-row update is fine and deliberately not checked: it means another
        // process booting on the same file gave this company its handle first,
        // and that handle is as good as this one.
        give.run(newHandle(company.name), company.id);
        break;
      } catch (error) {
        // A random clash draws again; anything else is a real fault.
        if (!/UNIQUE constraint failed: companies\.handle/.test((error as Error).message) || attempt >= 8) throw error;
      }
    }
  }
  if (unnamed.length > 0) console.log(`[db] gave ${unnamed.length} company(ies) a sign-in handle`);
}

/**
 * COMPANIES: A NAME IS NO LONGER UNIQUE (ADR 0018).
 *
 * A founder choosing a name already in use got a raw constraint error, message
 * and stack included: another company's existence, told to someone outside it.
 * Nothing looks a company up by name, and the handle identifies one, so the
 * constraint protects nothing and is removed. SQLite cannot drop a column's
 * UNIQUE, so this is a one-time rebuild, run only while a single-column unique
 * index on `name` exists. It runs AFTER the handle fill above, so the handle is
 * part of what is copied.
 *
 * THIS TABLE HOLDS EVERY COMPANY'S SPEND CAP. The copy is verbatim, and the
 * rebuild refuses to commit unless every row -- id, name, cap (compared as
 * text, so no integer is rounded in the comparison), created_at and handle --
 * reads back identical. Nine tables reference companies(id), by name, so they
 * resolve to the new table; foreign_key_check must come back empty.
 */
function migrateCompaniesDropNameUnique(): void {
  const indexes = db.prepare("PRAGMA index_list('companies')").all() as unknown as {
    name: string;
    unique: number;
  }[];
  const uniqueName = indexes.some((index) => {
    if (index.unique !== 1) return false;
    const columns = (db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as unknown as {
      name: string;
    }[]).map((c) => c.name);
    return columns.length === 1 && columns[0] === "name";
  });
  if (!uniqueName) return;

  const snapshot = () =>
    JSON.stringify(
      db
        .prepare(
          `SELECT id, name, CAST(spend_cap_base_units AS TEXT) AS cap, created_at, handle
             FROM companies ORDER BY id`,
        )
        .all(),
    );
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    const before = snapshot();
    db.exec(companiesTable("companies_migrated"));
    db.exec(
      `INSERT INTO companies_migrated (id, name, spend_cap_base_units, created_at, handle)
       SELECT id, name, spend_cap_base_units, created_at, handle FROM companies`,
    );
    db.exec("DROP TABLE companies");
    db.exec("ALTER TABLE companies_migrated RENAME TO companies");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS companies_handle_uniq ON companies(handle)");
    if (snapshot() !== before) {
      throw new Error("Refusing to continue: the companies rebuild did not copy every row exactly, spend caps included");
    }
    db.exec("COMMIT");
    console.log("[db] companies: a name is no longer unique; every row, spend caps included, copied exactly");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  if (violations.length > 0) {
    throw new Error(`Refusing to continue: ${violations.length} foreign key violation(s) after rebuilding companies`);
  }
}
migrateCompaniesDropNameUnique();

/**
 * USERS: ONE ACCOUNT PER ADDRESS PER COMPANY, NOT PER PLATFORM (ADR 0018).
 *
 * A one-time rebuild, because SQLite cannot drop a column's UNIQUE constraint.
 * It runs only while the old single-column unique index on `email` exists, so
 * a database already in the new shape (including every fresh one) is left
 * alone.
 *
 * FIVE TABLES POINT INTO users: sessions, invites.redeemed_by,
 * approval_requests.decided_by, qbo_postings.abandoned_by and
 * qbo_oauth_states.created_by. Ids are copied verbatim, and references are by
 * table name, so they resolve to the new table. That is proved, not assumed:
 * foreign_key_check must come back empty or boot refuses to continue.
 *
 * The old shape made every address unique platform-wide, so the new, weaker
 * constraint cannot be violated by rows that satisfied the old one.
 */
function migrateUsersToCompanyScopedEmail(): void {
  const indexes = db.prepare("PRAGMA index_list('users')").all() as unknown as {
    name: string;
    unique: number;
  }[];
  const globalEmail = indexes.some((index) => {
    if (index.unique !== 1) return false;
    const columns = (db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as unknown as {
      name: string;
    }[]).map((c) => c.name);
    return columns.length === 1 && columns[0] === "email";
  });
  if (!globalEmail) return;

  const before = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  // Foreign keys must be off for the drop/rename, and that pragma is a no-op
  // inside a transaction -- so it goes outside, as in migrateAgentsAddTeamId.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(usersTable("users_migrated"));
    db.exec(
      `INSERT INTO users_migrated (id, company_id, email, password_hash, role, created_at, disabled_at)
       SELECT id, company_id, email, password_hash, role, created_at, disabled_at FROM users`,
    );
    db.exec("DROP TABLE users");
    db.exec("ALTER TABLE users_migrated RENAME TO users");
    db.exec("CREATE INDEX IF NOT EXISTS users_company_idx ON users(company_id)");
    const after = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    if (Number(after) !== Number(before)) {
      throw new Error(`Refusing to continue: the users rebuild kept ${after} of ${before} rows`);
    }
    db.exec("COMMIT");
    console.log(`[db] users: an address is now unique per company, not platform-wide (${before} rows kept)`);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; the original error is what matters.
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    const enabled = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (!enabled.foreign_keys) {
      throw new Error("Refusing to continue: foreign key enforcement could not be restored");
    }
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown as unknown[];
  if (violations.length > 0) {
    throw new Error(`Refusing to continue: ${violations.length} foreign key violation(s) after rebuilding users`);
  }
}
migrateUsersToCompanyScopedEmail();

/* -------------------------------------------------------------------------
 * Alerting (ADR 0021).
 *
 * FIVE NEW TABLES, AND NOTHING EXISTING IS ALTERED. The sweeper only ever
 * READS the tables above, through their own company-scoped functions, and
 * writes here. That is what lets alerting be added without a single line of a
 * money path changing: if every row below vanished, payments, caps, approvals
 * and the books would behave exactly as they do without it.
 *
 * Plain `CREATE TABLE IF NOT EXISTS`, because every table is new.
 *
 * THE OUTCOME AND STATE COLUMNS ARE CLOSED BY CHECK, which is cheap on a new
 * table and is the second lock behind the TypeScript unions in
 * src/alerts/dispatch.ts. The point is narrower than tidiness: a delivery error
 * message can carry the webhook URL (safe-fetch embeds it in three of its), so
 * a column that may only hold one of these words is a column the URL cannot be
 * written into, by any code path, ever.
 * ---------------------------------------------------------------------- */
const ALERT_OUTCOMES = [
  "ok",
  "blocked_address",
  "redirect_refused",
  "timeout",
  "http_4xx",
  "http_5xx",
  "network_error",
  "invalid_url",
  "secret_unreadable",
];
const ALERT_OUTCOME_CHECK = ALERT_OUTCOMES.map((o) => `'${o}'`).join(", ");

db.exec(`
  CREATE TABLE IF NOT EXISTS alert_deliveries (
    id               TEXT PRIMARY KEY,
    company_id       TEXT NOT NULL REFERENCES companies(id),
    -- Which hourly ceiling this message spent. Three, kept apart so that what
    -- an agent can mint (approvals) and what is merely worth knowing (watch)
    -- can never use up the quota a real money problem needs.
    ceiling          TEXT NOT NULL CHECK (ceiling IN ('money', 'approval', 'watch')),
    status           TEXT NOT NULL CHECK (status IN ('due', 'sending', 'sent', 'failed', 'cancelled')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    next_attempt_at  TEXT NOT NULL,
    -- A claimed delivery is 'sending' until this passes; a crash in between
    -- returns it to the queue rather than sending it twice in parallel.
    lease_until      TEXT,
    last_attempt_at  TEXT,
    outcome          TEXT CHECK (outcome IS NULL OR outcome IN (${ALERT_OUTCOME_CHECK}))
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS alert_deliveries_due_idx ON alert_deliveries(status, next_attempt_at)");
db.exec("CREATE INDEX IF NOT EXISTS alert_deliveries_company_idx ON alert_deliveries(company_id, created_at)");

db.exec(`
  CREATE TABLE IF NOT EXISTS alert_events (
    id            TEXT PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES companies(id),
    -- A closed TypeScript union (src/alerts/events.ts), not a CHECK: the
    -- vocabulary will grow, and growing a CHECK means rebuilding the table.
    event         TEXT NOT NULL,
    severity      TEXT NOT NULL CHECK (severity IN ('money', 'watch')),
    ceiling       TEXT NOT NULL CHECK (ceiling IN ('money', 'approval', 'watch')),
    subject_key   TEXT NOT NULL,
    -- ONLY the alert-safe fields (names already made safe, a dollar string, a
    -- link). Never a reason, an address, a hash or a resource URL.
    payload_json  TEXT NOT NULL,
    opened_at     TEXT NOT NULL,
    -- NULL while the condition holds. Set when it clears; cleared again only by
    -- a reopen inside the cooldown, which is silent.
    resolved_at   TEXT,
    --   pending    waiting for a message: new, held by a ceiling, or handed
    --              back by a delivery that failed. Never a dead end.
    --   batched    in a delivery (delivery_id says which)
    --   baseline   already open when the webhook was first set: never sent
    --   silent     reopened inside the cooldown: deliberately not re-sent
    notify_state  TEXT NOT NULL CHECK (notify_state IN ('pending', 'batched', 'baseline', 'silent')),
    delivery_id   TEXT REFERENCES alert_deliveries(id)
  );
`);
// THE DEDUPE KEY. One OPEN row per (company, event, subject), enforced by the
// database: inserts use INSERT OR IGNORE against it, so a second sweep finding
// the same condition writes nothing rather than relying on a read beforehand.
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS alert_events_open_uniq ON alert_events(company_id, event, subject_key) WHERE resolved_at IS NULL",
);
db.exec("CREATE INDEX IF NOT EXISTS alert_events_state_idx ON alert_events(company_id, notify_state)");
db.exec("CREATE INDEX IF NOT EXISTS alert_events_resolved_idx ON alert_events(resolved_at)");
db.exec("CREATE INDEX IF NOT EXISTS alert_events_delivery_idx ON alert_events(delivery_id)");

/**
 * One webhook per company.
 *
 * `secret_enc` holds `encryptSecret(JSON {purpose, companyId, url, host})`. The
 * URL is a credential (Slack's secret is its path), so it is stored the way
 * QuickBooks tokens are, and the company and purpose inside the ciphertext are
 * checked on every decrypt: a blob copied onto another company's row, or into
 * another `_enc` column, is refused rather than used. Even the host lives
 * inside it, because for some receivers the host is the secret.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS alert_webhooks (
    company_id            TEXT PRIMARY KEY REFERENCES companies(id),
    secret_enc            TEXT NOT NULL,
    set_by                TEXT NOT NULL REFERENCES users(id),
    set_at                TEXT NOT NULL,
    -- Events already open at this moment were marked 'baseline' and are never
    -- sent: setting a webhook must not dump a company's history to a third party.
    baseline_at           TEXT NOT NULL,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    last_outcome          TEXT CHECK (last_outcome IS NULL OR last_outcome IN (${ALERT_OUTCOME_CHECK})),
    last_attempt_at       TEXT
  );
`);

/** Append-only: who changed where a company's alerts go, and when. No URL. */
db.exec(`
  CREATE TABLE IF NOT EXISTS alert_webhook_changes (
    id          TEXT PRIMARY KEY,
    company_id  TEXT NOT NULL REFERENCES companies(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    action      TEXT NOT NULL CHECK (action IN ('set', 'replaced', 'removed')),
    at          TEXT NOT NULL
  );
`);

/** When the sweeper last finished, so a dead sweeper does not look like a quiet one. */
db.exec(`
  CREATE TABLE IF NOT EXISTS alert_state (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    last_sweep_at  TEXT
  );
`);
