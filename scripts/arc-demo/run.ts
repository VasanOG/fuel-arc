/**
 * The demo runner: drives the Arc demo agent through Fuel's own API, exactly as
 * an agent and its operator would, and keeps its own log of every attempt.
 *
 *   npx tsx scripts/arc-demo/run.ts first    rehearsal            one $0.001 payment on Arc testnet
 *   npx tsx scripts/arc-demo/run.ts sequence rehearsal            the governed sequence, on Arc testnet
 *   npx tsx scripts/arc-demo/run.ts first    mainnet --live       REAL MONEY: one $0.001 payment
 *   npx tsx scripts/arc-demo/run.ts sequence mainnet --live       REAL MONEY: the governed sequence
 *
 * The network is named on the command line and must match MAINNET_DEMO.chain,
 * and mainnet also needs --live: the command itself is the confirmation, so a
 * run meant for the rehearsal can never spend real money.
 *
 * Talks to the demo instance started by start.sh (API 127.0.0.1:3200, shop
 * 127.0.0.1:3210), with that instance's own agent and operator keys, read from
 * ~/.fuel-arc/<instance>.env and never printed. Which instance is decided by
 * MAINNET_DEMO.chain in src/payments/arc-chain.ts.
 *
 * WHY IT KEEPS ITS OWN LOG. Some refusals happen before Fuel reserves anything,
 * so they write no ledger row: a frozen agent, for one, only bumps a counter.
 * The proof page shows those from this log, labelled as the runner's log, and
 * shows everything else from the ledger.
 *
 * The sequence:
 *   1. five ordinary $0.001 payments
 *   2. a $0.005 payment -> held as unusual -> approved with the operator key
 *      -> redeemed and paid
 *   3. one more $0.001, then a $0.01 -> refused by the $0.02-a-minute rate limit
 *   4. after the minute passes, the $0.01 again -> held -> approved -> paid
 *   5. freeze -> a payment is refused -> unfreeze
 *   6. the operator lowers the agent's cap to what it has spent -> a payment is
 *      refused by the cap -> the cap goes back to $2.00
 *   7. the operator runs the accounting rollup
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ARC_TESTNET, MAINNET_DEMO } from "../../src/payments/arc-chain.js";

const [mode, asked, live] = process.argv.slice(2);
if ((mode !== "first" && mode !== "sequence") || (asked !== "rehearsal" && asked !== "mainnet")) {
  console.error("usage: run.ts <first|sequence> <rehearsal|mainnet> [--live]");
  process.exit(2);
}

const chain = MAINNET_DEMO.chain;
const instance = chain.chainId === ARC_TESTNET.chainId ? "rehearsal" : "mainnet";
if (asked !== instance) {
  console.error(`MAINNET_DEMO.chain is ${chain.label}, not the ${asked} you asked for; nothing was sent.`);
  process.exit(1);
}
if (instance === "mainnet" && live !== "--live") {
  console.error("This would spend real USDC on Arc mainnet. Add --live to mean it; nothing was sent.");
  process.exit(1);
}
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const dir = join(homedir(), ".fuel-arc");
const settings = Object.fromEntries(
  readFileSync(join(dir, instance === "rehearsal" ? "rehearsal.env" : "fuel-arc.env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const API = "http://127.0.0.1:3200/api";
const SHOP = "http://127.0.0.1:3210";
const AGENT = MAINNET_DEMO.agentId;
const logFile = join(dir, `${instance}-runlog.jsonl`);

async function call(role: "agent" | "operator", method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${role === "agent" ? settings.FUEL_AGENT_KEY : settings.FUEL_API_KEY}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

function record(step: string, entry: Record<string, unknown>) {
  const line = { at: new Date().toISOString(), instance, chain: chain.label, commit, step, ...entry };
  appendFileSync(logFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  const tx = typeof entry.transaction === "string" && entry.transaction ? `  ${chain.explorerUrl}/tx/${entry.transaction}` : "";
  console.log(`${step.padEnd(44)} HTTP ${entry.status}  ${entry.summary}${tx}`);
}

function outcomeOf(status: number, json: Record<string, unknown>): string {
  if (status === 200) return "paid";
  if (status === 202) return "held for approval";
  if (status === 402) return json.scope === "approval" ? "refused (approval not valid)" : "refused (cap)";
  if (status === 423) return "refused (agent frozen)";
  if (status === 429) return "refused (rate limit)";
  if (status === 502) return "not completed (see the ledger: if it was signed, money may have moved)";
  return `unexpected HTTP ${status}`;
}

/** An operator step that did not apply stops the run: the next payment would otherwise really pay. */
function mustSucceed(step: string, status: number, json: Record<string, unknown>): void {
  if (status === 200) return;
  record(step, { status, outcome: "operator step failed; run stopped", summary: JSON.stringify(json).slice(0, 200) });
  process.exit(1);
}

async function payFor(step: string, item: "basic" | "unusual" | "ceiling", approvalRequestId?: string) {
  const r = await call("agent", "POST", `/agents/${AGENT}/pay`, { url: `${SHOP}/item/${item}`, ...(approvalRequestId ? { approvalRequestId } : {}) });
  const outcome = outcomeOf(r.status, r.json);
  record(step, {
    item,
    status: r.status,
    outcome,
    summary: `${outcome}${r.json.paid ? ` $${r.json.paid}` : ""}${r.json.scope ? ` [${r.json.scope}]` : ""}${r.json.error ? ` -- ${r.json.error}` : ""}`,
    transaction: r.json.transaction ?? null,
    approvalRequestId: r.json.approvalRequestId ?? approvalRequestId ?? null,
    scope: r.json.scope ?? null,
  });
  return r;
}

async function approve(step: string, id: string) {
  const r = await call("operator", "POST", `/approvals/${id}/approve`);
  mustSucceed(step, r.status, r.json);
  record(step, { status: r.status, outcome: r.status === 200 ? "approved" : "not approved", summary: r.status === 200 ? "approved with the operator key" : JSON.stringify(r.json), approvalRequestId: id, decidedBy: "operator key" });
}

async function holdApproveRedeem(label: string, item: "unusual" | "ceiling") {
  const held = await payFor(`${label}: ${item}`, item);
  if (held.status !== 202) return;
  await approve(`${label}: operator approves`, held.json.approvalRequestId as string);
  await payFor(`${label}: ${item}, approved`, item, held.json.approvalRequestId as string);
}

const health = await fetch("http://127.0.0.1:3200/health").catch(() => null);
if (!health?.ok) {
  console.error("the demo API is not running on 127.0.0.1:3200 (scripts/arc-demo/start.sh)");
  process.exit(1);
}
console.log(`${chain.label}: agent ${MAINNET_DEMO.address} pays the founder's shop ${MAINNET_DEMO.payee}\nlog: ${logFile}\n`);

if (mode === "first") {
  await payFor("first payment: basic", "basic");
} else {
  for (let i = 1; i <= 5; i++) await payFor(`1. ordinary payment ${i} of 5`, "basic");
  await holdApproveRedeem("2. unusual amount", "unusual");
  await payFor("3. one more ordinary payment", "basic");
  await payFor("3. a $0.01 payment in the same minute", "ceiling");
  console.log("   (waiting 65 s for the rate-limit window to clear)");
  await new Promise((r) => setTimeout(r, 65_000));
  await holdApproveRedeem("4. the $0.01 payment again", "ceiling");

  const frozen = await call("operator", "POST", `/agents/${AGENT}/freeze`, { reason: "demo: operator stop" });
  mustSucceed("5. operator freezes the agent", frozen.status, frozen.json);
  record("5. operator freezes the agent", { status: frozen.status, outcome: "frozen", summary: "freeze" });
  await payFor("5. a payment while frozen", "basic");
  const thawed = await call("operator", "POST", `/agents/${AGENT}/unfreeze`);
  mustSucceed("5. operator unfreezes the agent", thawed.status, thawed.json);
  record("5. operator unfreezes the agent", { status: thawed.status, outcome: "unfrozen", summary: "unfreeze" });

  const agent = await call("operator", "GET", `/agents/${AGENT}`);
  mustSucceed("6. operator reads the agent", agent.status, agent.json);
  const spent = String(agent.json.spent);
  const lowered = await call("operator", "PATCH", `/agents/${AGENT}`, { spendCapUsd: spent });
  mustSucceed("6. operator sets the cap to what is spent", lowered.status, lowered.json);
  record("6. operator sets the cap to what is spent", { status: lowered.status, outcome: "cap lowered", summary: `cap $${spent}` });
  await payFor("6. a payment over the cap", "basic");
  const restored = await call("operator", "PATCH", `/agents/${AGENT}`, { spendCapUsd: "2.00" });
  mustSucceed("6. operator restores the cap", restored.status, restored.json);
  record("6. operator restores the cap", { status: restored.status, outcome: "cap restored", summary: "cap $2.00" });

  const rollup = await call("operator", "POST", "/postings/run");
  mustSucceed("7. operator runs the accounting rollup", rollup.status, rollup.json);
  record("7. operator runs the accounting rollup", { status: rollup.status, outcome: "rollup", summary: `${rollup.json.linesCreated} line(s), $${rollup.json.posted} posted` });
}
