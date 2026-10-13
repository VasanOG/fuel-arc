/**
 * Records scripts/fixtures/x402-quotes-main.json: the three price quotes that
 * verify-startup's GS-13 holds the current code to.
 *
 *   node --import tsx scripts/record-quote-fixture.ts <commit>
 *
 * WHY A SEPARATE COMMIT. GS-13 exists to show that the startup fix moved no
 * price, recipient, network, asset or time limit. A fixture recorded from the
 * code under test would compare that code with itself, so the quotes are taken
 * from a commit before the change -- `d660535`, main before the gateway
 * startup fix, for the fixture in the repository.
 *
 * WHAT IT DOES, all offline and on throwaway data:
 *   1. checks <commit> out on its own in a temporary worktree, borrowing this
 *      checkout's node_modules;
 *   2. builds a test database and seeds it with THIS checkout's
 *      scripts/lib/startup-fixtures.ts -- the same seeding GS-13 uses;
 *   3. runs <commit>'s own src/server.ts under THIS checkout's
 *      scripts/lib/offline-network.mjs in "up" mode, so its handshake is
 *      answered by scripts/fixtures/x402-supported.json and nothing leaves
 *      the machine;
 *   4. asks the gateway, /paid-hello and /paid-hello-large for a quote, picks
 *      the payment terms with the same pickQuote, and writes the fixture;
 *   5. stops that server and removes the worktree.
 */
import { createTestDatabase } from "./lib/test-db.js";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const commit = process.argv[2];
if (!commit) throw new Error("usage: node --import tsx scripts/record-quote-fixture.ts <commit>");
const ROOT = resolve(".");
const sha = execFileSync("git", ["rev-parse", "--short", commit], { encoding: "utf8" }).trim();

const scratch = createTestDatabase("quotes");
process.env.FUEL_DB_PATH = scratch;
const key = randomBytes(32).toString("hex");
process.env.FUEL_TOKEN_ENCRYPTION_KEY = key;
const fx = await import("./lib/startup-fixtures.js");
const seeded = await fx.seedGatewayEndpoints();

const work = mkdtempSync(join(tmpdir(), "fuel-quotes-"));
const tree = join(work, "tree");
execFileSync("git", ["worktree", "add", "--quiet", "--detach", tree, sha]);
symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
const network = mkdtempSync(join(work, "net-"));
writeFileSync(join(network, "mode"), "up\n");
const port: number = await new Promise((done) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address() as { port: number };
    s.close(() => done(port));
  });
});

const server = spawn(process.execPath, ["--import", "tsx", "--import", join(ROOT, "scripts", "lib", "offline-network.mjs"), "src/server.ts"], {
  cwd: tree,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    DOTENV_CONFIG_PATH: "/dev/null",
    FUEL_DB_PATH: scratch,
    FUEL_TOKEN_ENCRYPTION_KEY: key,
    FUEL_API_KEY: `op-${randomBytes(16).toString("hex")}`,
    FUEL_AGENT_KEY: `ag-${randomBytes(16).toString("hex")}`,
    X402_PAY_TO: fx.QUOTE_SEED.payTo,
    PORT: String(port),
    FUEL_TEST_NETWORK_DIR: network,
  },
});
let output = "";
server.stdout.on("data", (c: Buffer) => (output += c.toString()));
server.stderr.on("data", (c: Buffer) => (output += c.toString()));

try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    const up = await fetch(`${base}/health`).then((r) => r.ok, () => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 1_000)); // the handshakes, answered at once in "up"
  const quotes: Record<string, unknown> = {};
  for (const [name, path] of [
    ["gateway", `/earn/${seeded.gateway.publicId}`],
    ["paid-hello", "/paid-hello"],
    ["paid-hello-large", "/paid-hello-large"],
  ] as const) {
    const res = await fetch(base + path);
    if (res.status !== 402) throw new Error(`${name}: expected a 402 quote, got ${res.status}\n${output}`);
    quotes[name] = fx.pickQuote(res.headers.get("payment-required"));
  }
  const fixture = {
    recordedAt: new Date().toISOString(),
    recordedFrom: `main at ${sha}, before the gateway startup fix, with its facilitator handshake answered by scripts/fixtures/x402-supported.json (offline)`,
    seed: { ...fx.QUOTE_SEED },
    quotes,
  };
  writeFileSync(join("scripts", "fixtures", "x402-quotes-main.json"), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`Recorded three quotes from ${sha} into scripts/fixtures/x402-quotes-main.json`);
} finally {
  server.kill("SIGTERM");
  rmSync(join(tree, "node_modules"), { force: true });
  execFileSync("git", ["worktree", "remove", "--force", tree]);
  rmSync(work, { recursive: true, force: true });
}
