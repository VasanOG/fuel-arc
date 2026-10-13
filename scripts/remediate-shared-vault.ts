/**
 * Gives the empty-balance test agent its own vault, so no two agents share one.
 *
 * THE PROBLEM. `trap-bot` and `empty-balance-test-agent` both hold Fireblocks
 * vault 4. In Phase 1 that was deliberate: vault 4 held no money, and the
 * fixture existed to prove Fuel fails closed on an empty wallet. Vault 4 is not
 * empty any more -- trap-bot has settled payments from it -- so today two
 * agents with two separate spend caps draw on one pool of money, each cap blind
 * to the other's spending. 7A-1 makes that unrepresentable
 * (`UNIQUE (fireblocks_vault_id)`), and the migration refuses to boot a
 * database that still holds the pair. See docs/shared-vault-remediation.md.
 *
 * WHICH AGENT MOVES. trap-bot keeps vault 4: its settled payments were signed
 * by that vault, and moving it would make its history name a vault it no longer
 * holds. The fixture has never settled a payment, and its purpose -- an agent
 * with nothing to spend -- is served exactly by a brand-new vault.
 *
 * WHY RAW node:sqlite. Importing src/db/index.ts RUNS the migrations, and the
 * migration is what refuses this database. The repair has to be able to open
 * the file the application currently will not.
 *
 * WHAT --confirm DOES, AND NOTHING ELSE.
 *   1. Re-checks the exact pre-state below; any difference, and it stops.
 *   2. Backs the database up (VACUUM INTO, a consistent copy).
 *   3. ONE sandbox provisioning operation (a handful of Fireblocks sandbox API
 *      requests): an empty vault named after the fixture's id. Idempotent by
 *      that name, so a re-run after a crash between 3 and 4 re-finds the same
 *      vault instead of making another.
 *   4. One guarded UPDATE of one row, conditioned on it still holding vault 4.
 * No funds move. No payment, approval or ledger row is touched.
 *
 * Run:
 *   npx tsx scripts/remediate-shared-vault.ts              # report only, no network
 *   npx tsx scripts/remediate-shared-vault.ts --confirm    # the sandbox call + update
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const DB_PATH = process.env.FUEL_DB_PATH ?? "fuel.db";
const confirm = process.argv.includes("--confirm");

const SHARED_VAULT = "4";
const HOLDER_ID = "80081c73-9426-4406-b7b2-8e11670f40d3"; // trap-bot: keeps vault 4
const FIXTURE_ID = "d6f29943-241d-4874-a0a2-9a21f7c7ebb0"; // empty-balance-test-agent: moves

/**
 * The same formula as vaultNameFor in src/agents/create.ts, written out rather
 * than imported: that module reaches src/db/index.ts, whose migration refuses
 * this database. verify-api asserts the two agree.
 */
const NEW_VAULT_NAME = `fuel-agent-${FIXTURE_ID}`;

interface AgentRow {
  id: string;
  name: string;
  fireblocks_vault_id: string;
  address: string;
}

function fail(message: string): never {
  console.error(`\nREFUSING: ${message}\nNothing was changed.`);
  process.exit(1);
}

function agent(db: DatabaseSync, id: string): AgentRow | undefined {
  return db
    .prepare("SELECT id, name, fireblocks_vault_id, address FROM agents WHERE id = ?")
    .get(id) as AgentRow | undefined;
}

function sharedVaults(db: DatabaseSync): { vault: string; ids: string }[] {
  return db
    .prepare(
      `SELECT fireblocks_vault_id AS vault, GROUP_CONCAT(id, ', ') AS ids
         FROM agents GROUP BY fireblocks_vault_id HAVING COUNT(*) > 1`,
    )
    .all() as unknown as { vault: string; ids: string }[];
}

function countBy(db: DatabaseSync, sql: string, id: string): string {
  const rows = db.prepare(sql).all(id) as unknown as { status: string; n: number }[];
  return rows.length === 0 ? "none" : rows.map((r) => `${r.status} ${r.n}`).join(", ");
}

/**
 * Everything that must be true for this repair to be the right one.
 *
 * Returns "done" when the fixture already has its own vault and nothing is
 * shared, so a second run is a harmless no-op rather than an error.
 */
function checkPreState(db: DatabaseSync): "needed" | "done" {
  const fixture = agent(db, FIXTURE_ID);
  const holder = agent(db, HOLDER_ID);
  if (!fixture) fail(`the fixture agent ${FIXTURE_ID} does not exist`);
  if (!holder) fail(`the holder agent ${HOLDER_ID} does not exist`);

  const shared = sharedVaults(db);
  if (fixture.fireblocks_vault_id !== SHARED_VAULT && shared.length === 0) return "done";

  if (fixture.fireblocks_vault_id !== SHARED_VAULT) {
    fail(`the fixture no longer holds vault ${SHARED_VAULT}, but vaults are still shared: ${JSON.stringify(shared)}`);
  }
  if (holder.fireblocks_vault_id !== SHARED_VAULT) {
    fail(`the holder does not hold vault ${SHARED_VAULT} (holds ${holder.fireblocks_vault_id})`);
  }
  if (holder.address !== fixture.address) {
    fail("the two agents on vault 4 record different addresses; that is not the known state");
  }
  // Exactly this pair, and no other sharing anywhere: otherwise this repair
  // would not make the database bootable and something unknown is going on.
  if (
    shared.length !== 1 ||
    shared[0]!.vault !== SHARED_VAULT ||
    shared[0]!.ids.split(", ").sort().join(",") !== [FIXTURE_ID, HOLDER_ID].sort().join(",")
  ) {
    fail(`vault sharing is not exactly the known pair: ${JSON.stringify(shared)}`);
  }

  // Nothing of the fixture's may depend on vault 4 going forward.
  const one = (sql: string) => Number((db.prepare(sql).get(FIXTURE_ID) as { n: number }).n);
  if (one("SELECT COUNT(*) AS n FROM payments WHERE agent_id = ? AND status = 'settled'") > 0) {
    fail("the fixture has settled payments; its history would name a vault it no longer holds");
  }
  if (one("SELECT COUNT(*) AS n FROM payments WHERE agent_id = ? AND status IN ('pending', 'signing')") > 0) {
    fail("the fixture has a payment in flight");
  }
  if (one("SELECT COUNT(*) AS n FROM approval_requests WHERE agent_id = ? AND status IN ('pending', 'approved')") > 0) {
    fail("the fixture has a live approval that could still be redeemed");
  }
  if (one("SELECT COUNT(*) AS n FROM earning_endpoints WHERE agent_id = ?") > 0) {
    fail("the fixture has an earning endpoint, which receives money at its recorded address");
  }
  if (one("SELECT COUNT(*) AS n FROM receipts WHERE agent_id = ?") > 0) {
    fail("the fixture has received money at vault 4's address");
  }
  return "needed";
}

function report(db: DatabaseSync): void {
  const holder = agent(db, HOLDER_ID)!;
  const fixture = agent(db, FIXTURE_ID)!;
  const byStatus = "SELECT status, COUNT(*) AS n FROM payments WHERE agent_id = ? GROUP BY status ORDER BY status";
  console.log(`\nDatabase: ${DB_PATH}`);
  console.log(`\nVault ${SHARED_VAULT} is held by two agents:`);
  console.log(`  KEEPS IT  ${holder.name} (${holder.id})`);
  console.log(`            payments: ${countBy(db, byStatus, HOLDER_ID)}`);
  console.log(`  MOVES     ${fixture.name} (${fixture.id})`);
  console.log(`            payments: ${countBy(db, byStatus, FIXTURE_ID)}`);
  console.log(
    "            (these stay attached to the agent and are not rewritten; the unreconciled one was signed by vault 4)",
  );
}

async function main(): Promise<void> {
  if (!existsSync(DB_PATH)) fail(`${DB_PATH} does not exist`);

  const readOnly = new DatabaseSync(DB_PATH, { readOnly: true });
  const state = checkPreState(readOnly);
  if (state === "done") {
    console.log(`\n${DB_PATH}: the fixture already has its own vault and no vault is shared. Nothing to do.`);
    readOnly.close();
    return;
  }
  report(readOnly);
  readOnly.close();

  const backupPath = `${DB_PATH}.bak-shared-vault-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  console.log("\nWith --confirm this would:");
  console.log(`  1. back up ${DB_PATH} to ${backupPath}`);
  console.log(`  2. run ONE provisioning operation against the Fireblocks SANDBOX for a new, empty vault named`);
  console.log(`       ${NEW_VAULT_NAME}`);
  console.log(`     That is several sandbox API requests: look the name up (reused if an interrupted`);
  console.log(`     earlier run created it), create the vault, activate its two test assets and read`);
  console.log(`     their address. Afterwards, one read of the new vault's balance.`);
  console.log(`  3. run, in one transaction:`);
  console.log(`       UPDATE agents SET fireblocks_vault_id = <new vault id>, address = <new address>`);
  console.log(`        WHERE id = '${FIXTURE_ID}' AND fireblocks_vault_id = '${SHARED_VAULT}'`);
  console.log(`     and require it to change exactly one row.`);
  console.log(`  No funds move. No payment, approval or ledger row is changed. Mainnet is unreachable:`);
  console.log(`  the script refuses unless the Fireblocks base path is the sandbox.`);

  if (!confirm) {
    console.log("\nDry run: no network call was made and nothing was written.");
    return;
  }

  // ---- --confirm ----------------------------------------------------------

  // Imported only here, so a dry run needs no credentials and cannot reach the
  // network even by accident.
  await import("dotenv/config");
  const { BasePath } = await import("@fireblocks/ts-sdk");
  const { BASE_PATH, provisionAgentWallet, getVaultUsdcBalance } = await import(
    "../src/fireblocks/provision.js"
  );
  if (BASE_PATH !== BasePath.Sandbox) fail(`Fireblocks base path is ${BASE_PATH}, not the sandbox`);

  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = ON");
  if (checkPreState(db) !== "needed") fail("the pre-state changed between the report and --confirm");

  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  console.log(`\nBacked up to ${backupPath}`);

  console.log(`Provisioning ${NEW_VAULT_NAME} in the Fireblocks sandbox...`);
  const wallet = await provisionAgentWallet(NEW_VAULT_NAME);
  console.log(`  vault ${wallet.vaultAccountId}`);

  if (!wallet.vaultAccountId || wallet.vaultAccountId === SHARED_VAULT) {
    fail(`provisioning returned vault "${wallet.vaultAccountId}", which is not a new vault`);
  }
  const alreadyHeld = db
    .prepare("SELECT id FROM agents WHERE fireblocks_vault_id = ?")
    .get(wallet.vaultAccountId) as { id: string } | undefined;
  if (alreadyHeld) {
    fail(`provisioning returned vault ${wallet.vaultAccountId}, which agent ${alreadyHeld.id} already holds`);
  }
  const holder = agent(db, HOLDER_ID)!;
  if (wallet.address.toLowerCase() === holder.address.toLowerCase()) {
    fail("the new vault resolved to vault 4's address");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const { changes } = db
      .prepare(
        `UPDATE agents SET fireblocks_vault_id = ?, address = ?
          WHERE id = ? AND fireblocks_vault_id = ?`,
      )
      .run(wallet.vaultAccountId, wallet.address, FIXTURE_ID, SHARED_VAULT);
    if (Number(changes) !== 1) throw new Error(`the update changed ${changes} rows, not 1`);
    if (sharedVaults(db).length !== 0) throw new Error("vaults are still shared after the update");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    fail(
      `${(error as Error).message}. The sandbox vault ${wallet.vaultAccountId} exists but no agent ` +
        "holds it; re-running reuses it.",
    );
  }
  db.close();

  const balance = await getVaultUsdcBalance(wallet.vaultAccountId);
  console.log(`\nDone. ${FIXTURE_ID} now holds vault ${wallet.vaultAccountId}; trap-bot keeps vault ${SHARED_VAULT}.`);
  console.log(`New vault balance: ${balance ?? "unknown (read failed)"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
