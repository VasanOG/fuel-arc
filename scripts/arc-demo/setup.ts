/**
 * Builds the Arc founder demo's own database -- never `fuel.db`.
 *
 *   npx tsx scripts/arc-demo/setup.ts rehearsal   ->  ~/.fuel-arc/rehearsal.db  (Arc testnet wallets)
 *   npx tsx scripts/arc-demo/setup.ts mainnet     ->  ~/.fuel-arc/fuel-arc.db   (Arc mainnet wallets)
 *
 * One company, one team, one agent, and no users -- so approvals are decided
 * with the instance's operator key (D8) and are labelled that way. Caps (D4):
 * agent $2, team $3, company $4. The agent's wallet is the one keygen.ts made;
 * it is attached through createAgentWithCustody with a provisioner that returns
 * that address, so nothing here calls Fireblocks.
 *
 * Also writes `<instance>.env` (0600) beside the database: the instance's own
 * operator and agent keys and token-encryption key. None of them is printed.
 *
 * Prints the ids to record in MAINNET_DEMO (src/payments/arc-chain.ts).
 * Refuses to touch a database or env file that already exists.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const INSTANCES = {
  rehearsal: { db: "rehearsal.db", env: "rehearsal.env", agent: "test-agent.address", shop: "test-shop.address" },
  mainnet: { db: "fuel-arc.db", env: "fuel-arc.env", agent: "agent.address", shop: "shop.address" },
} as const;

const which = process.argv[2] as keyof typeof INSTANCES;
if (!(which in INSTANCES)) {
  console.error("usage: setup.ts <rehearsal|mainnet>");
  process.exit(2);
}
const instance = INSTANCES[which];
const dir = resolve(homedir(), ".fuel-arc");
if ((statSync(dir).mode & 0o077) !== 0) throw new Error(`${dir} must be 0700`);
const dbPath = join(dir, instance.db);
const envPath = join(dir, instance.env);
for (const p of [dbPath, envPath]) {
  if (existsSync(p)) {
    console.error(`${p} already exists; refusing to touch it.`);
    process.exit(1);
  }
}
const read = (file: string) => readFileSync(join(dir, file), "utf8").trim();
const agentAddress = read(instance.agent);
const shopAddress = read(instance.shop);

// Before anything opens a database: this one, and only this one.
process.env.FUEL_DB_PATH = dbPath;
const { DB_PATH, db } = await import("../../src/db/index.js");
if (resolve(DB_PATH) !== dbPath) throw new Error(`refusing: opened ${DB_PATH}`);

const { bootstrapCompany, setCompanySpendCap } = await import("../../src/db/companies.js");
const { setTeamSpendCap } = await import("../../src/db/teams.js");
const { createAgentWithCustody } = await import("../../src/agents/create.js");

const company = bootstrapCompany();
const team = db.prepare("SELECT id FROM teams WHERE company_id = ?").all(company.id) as { id: string }[];
if (team.length !== 1) throw new Error(`expected one team in a fresh database, found ${team.length}`);
const teamId = team[0]!.id;

db.prepare("UPDATE companies SET name = ? WHERE id = ?").run("Fuel founder demo (Arc)", company.id);
db.prepare("UPDATE teams SET name = ? WHERE id = ?").run("Arc demo", teamId);
setCompanySpendCap(company.id, 4_000_000n);
setTeamSpendCap(teamId, 3_000_000n);

const agent = await createAgentWithCustody(
  { name: "arc-demo-agent", teamId, spendCapBaseUnits: 2_000_000n },
  async (vaultName) => ({ vaultAccountId: `no-vault:${vaultName}`, address: agentAddress }),
);

const users = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE company_id = ?").get(company.id) as { n: number }).n;
if (users !== 0) throw new Error("the demo company must have no users (D8)");

writeFileSync(
  envPath,
  [
    `FUEL_DB_PATH=${dbPath}`,
    `FUEL_TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`,
    `FUEL_API_KEY=op-${randomBytes(24).toString("hex")}`,
    `FUEL_AGENT_KEY=ag-${randomBytes(24).toString("hex")}`,
    "",
  ].join("\n"),
  { mode: 0o600, flag: "wx" },
);

console.log(`\n${which} demo database: ${dbPath}`);
console.log("record these in MAINNET_DEMO (src/payments/arc-chain.ts):");
console.log(`  companyId: "${company.id}",`);
console.log(`  agentId: "${agent.id}",`);
console.log(`  address: "${agentAddress}",`);
console.log(`  payee: "${shopAddress}",`);
console.log("caps: agent $2.00, team $3.00, company $4.00; users: 0");
